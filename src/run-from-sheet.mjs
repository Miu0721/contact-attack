// src/run-from-sheet.mjs
import { chromium } from 'playwright';
// URL探索ロジックは現在無効化中
import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
import { fillContactForm /*, confirmAndSubmit */ } from './contact-form-filler.mjs';

// デフォルト値（シートが読めないとき用）
import { SENDER_INFO, FIXED_MESSAGE } from './config/sender.mjs';

// Sender 情報を Google スプレッドシートから読む
import {
  loadSenderFromSheet,
  appendFormQuestionsAndAnswers,
} from './config/sender-from-sheet.mjs';

import {
  fetchContacts,
  updateContactRowValues,
  // updateContactRowColor, // 必要なら復活させる
} from './lib/google/contactsRepo.mjs';

// import { notifySlack } from './lib/slack.mjs';

(async () => {
  // 0. Sender シートから自社情報を読み込み（失敗したら null）
  const senderFromSheet = await loadSenderFromSheet().catch((err) => {
    console.warn(
      'Sender シートの読み込みに失敗しました（sender.mjs をフォールバック使用）:',
      err?.message || err
    );
    return null;
  });

  // シートからの senderInfo（なければ空オブジェクト）
  const sheetSender = senderFromSheet?.senderInfo || {};

  // フィールドごとに「シート優先、なければ sender.mjs の値」
  const senderInfo = {
    name: sheetSender.name || SENDER_INFO.name,
    nameKana: sheetSender.nameKana || SENDER_INFO.nameKana,
    lastName: sheetSender.lastName || SENDER_INFO.lastName,
    firstName: sheetSender.firstName || SENDER_INFO.firstName,
    lastNameKana: sheetSender.lastNameKana || SENDER_INFO.lastNameKana,
    firstNameKana: sheetSender.firstNameKana || SENDER_INFO.firstNameKana,
    email: sheetSender.email || SENDER_INFO.email,
    company: sheetSender.company || SENDER_INFO.company,
    department: sheetSender.department || SENDER_INFO.department,
    phone: sheetSender.phone || SENDER_INFO.phone,
  };

  const fixedMessage =
    senderFromSheet?.fixedMessage &&
    senderFromSheet.fixedMessage.trim().length > 0
      ? senderFromSheet.fixedMessage
      : FIXED_MESSAGE;

  const contactPrompt = senderFromSheet?.contactPrompt || '';

  console.log('📨 使用する Sender 情報:', senderInfo);
  console.log(
    '📝 fixedMessage の先頭30文字:',
    fixedMessage ? fixedMessage.slice(0, 30) + '...' : '(空)'
  );

  const contacts = await fetchContacts();
  if (!contacts.length) {
    console.log('Contacts シートにデータがありません');
    return;
  }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  for (const contact of contacts) {
    // すでに処理済みならスキップ
    if (
      contact.status &&
      contact.status !== '' &&
      contact.status !== 'Pending'
    ) {
      console.log(`⏩ Skip: ${contact.companyName} (status=${contact.status})`);
      continue;
    }

    console.log(`🚀 Processing: ${contact.companyName} (row ${contact.rowIndex})`);

    const timestamp = new Date().toISOString();
    let runCount = (contact.runCount || 0) + 1;

    let status = 'Failed';
    let lastResult = '';
    let lastErrorMsg = '';
    let contactUrl = contact.contactUrl;

    try {
      // 1. URL 決定（Contact URL が空ならサイトTOPから探索）
      const baseUrl = contact.siteUrl || contact.contactUrl;
      if (!baseUrl) {
        throw new Error('Site URL / Contact URL が両方空です');
      }

      // URL探索は停止中なので、contactUrl が空なら失敗としてスキップ
      if (!contactUrl) {
        lastResult = 'form_not_found';
        lastErrorMsg = '問い合わせフォームURLが未設定のため処理をスキップしました';
        status = 'Failed';
        console.warn('❌ 問い合わせページURLが見つからない');

        // await notifySlack(
        //   `[contact-attack-bot] ❌ フォームURL特定失敗\n` +
        //     `会社名: ${contact.companyName}\n` +
        //     `ベースURL: ${baseUrl}\n` +
        //     `row: ${contact.rowIndex}\n` +
        //     `エラー: ${lastErrorMsg}`
        // );

        await updateContactRowValues(contact, {
          contactUrl,
          status,
          lastRunAt: timestamp,
          lastResult,
          lastErrorMsg,
          runCount,
        });
        continue;
      }

      let filledSummary = [];
      let formSchema = null;
      let success = false;

      // URL探索はしないので contactUrl のみを試行
      const candidateUrls = [contactUrl];

      for (const candidate of candidateUrls) {
        contactUrl = candidate;
        console.log('📨 問い合わせページを試行:', contactUrl);
        try {
          await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });
        } catch (navErr) {
          console.warn('⚠️ ページ遷移に失敗:', navErr?.message || navErr);
          lastErrorMsg = navErr?.message || String(navErr);
          continue;
        }

        formSchema = await analyzeContactFormWithAI(page);
        if (!formSchema) {
          console.warn('❌ フォーム構造解析に失敗');
          lastResult = 'form_schema_error';
          lastErrorMsg = 'フォーム構造を解析できませんでした';
          continue;
        }

        console.log('🧾 form schema:', JSON.stringify(formSchema, null, 2));

        filledSummary =
          (await fillContactForm(page, formSchema, senderInfo, fixedMessage)) ||
          [];

        // reCAPTCHA 等を検出した場合はシートに記録して次のリンクへ
        const captchaEntry = filledSummary.find((f) => f.role === 'captcha');
        if (captchaEntry) {
          lastResult = 'captcha_detected';
          lastErrorMsg = 'reCAPTCHA/anti-bot 要素を検出しました（手動対応が必要です）';
          status = 'Failed';

          try {
            await appendFormQuestionsAndAnswers({
              contact,
              contactUrl,
              siteUrl: contact.siteUrl,
              filledSummary,
              formSchema,
            });
          } catch (logErr) {
            console.warn(
              '⚠️ フォーム質問ログの書き込みに失敗:',
              logErr?.message || logErr
            );
          }

          // 次のリンク/企業へ
          success = true; // これ以上のエラー通知を避けるため success として扱う
          break;
        }

        if (filledSummary.length === 0) {
          console.warn('⚠️ 入力サマリが空でした');
          lastResult = 'fill_empty';
          lastErrorMsg = '入力できるフィールドがありませんでした';
          continue;
        }

        success = true;

        try {
          await appendFormQuestionsAndAnswers({
            contact,
            contactUrl,
            siteUrl: contact.siteUrl,
            filledSummary,
            formSchema,
          });
        } catch (logErr) {
          console.warn(
            '⚠️ フォーム質問ログの書き込みに失敗:',
            logErr?.message || logErr
          );
        }

        lastResult = 'filled';
        status = 'Success';

        // 送信は安全のため現在無効化
        break;
      }

      if (!success) {
        status = 'Failed';
        if (!lastResult) lastResult = 'form_not_filled';

        // await notifySlack(
        //   `[contact-attack-bot] ❌ フォーム入力に失敗（URL探索なし）\n` +
        //     `会社名: ${contact.companyName}\n` +
        //     `問い合わせURL候補: ${candidateUrls.join(', ')}\n` +
        //     `row: ${contact.rowIndex}\n` +
        //     `エラー: ${lastErrorMsg}`
        // );
      }
    } catch (err) {
      console.error('💥 Error while processing contact:', err);
      lastResult = 'exception';
      lastErrorMsg = String(err);
      status = 'Failed';

      // Slack 通知（予期しない例外）
      // await notifySlack(
      //   `[contact-attack-bot] 🔴 例外発生\n` +
      //     `会社名: ${contact.companyName}\n` +
      //     `siteUrl: ${contact.siteUrl}\n` +
      //     `contactUrl: ${contactUrl || '(未決定)'}\n` +
      //     `row: ${contact.rowIndex}\n` +
      //     `エラー: ${lastErrorMsg}`
      // );
    }

    // 4. シート更新
    await updateContactRowValues(contact, {
      contactUrl,
      status,
      lastRunAt: timestamp,
      lastResult,
      lastErrorMsg,
      runCount,
    });

    // await updateContactRowColor(contact.rowIndex, status);

    // 負荷・レート制御（1〜3秒待機）
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  }

  await browser.close();
})();
