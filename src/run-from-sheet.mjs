// src/run-from-sheet.mjs
import { chromium } from 'playwright';
import { findContactPageUrl } from './url-discovery.mjs';
import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
import { fillContactForm } from './contact-form-filler.mjs';

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

import { notifySlack } from './lib/slack.mjs';

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

      if (!contactUrl) {
        contactUrl = await findContactPageUrl(page, baseUrl);
        if (!contactUrl) {
          lastResult = 'form_not_found';
          lastErrorMsg = '問い合わせフォームURLを特定できませんでした';
          status = 'Failed';
          console.warn('❌ 問い合わせページURLが見つからない');

          // Slack 通知（フォームURL見つからないケース）
          await notifySlack(
            `[contact-attack-bot] ❌ フォームURL特定失敗\n` +
              `会社名: ${contact.companyName}\n` +
              `ベースURL: ${baseUrl}\n` +
              `row: ${contact.rowIndex}\n` +
              `エラー: ${lastErrorMsg}`
          );

          // シート更新だけして次へ
          await updateContactRowValues(contact, {
            contactUrl,
            status,
            lastRunAt: timestamp,
            lastResult,
            lastErrorMsg,
            runCount,
          });
          // await updateContactRowColor(contact.rowIndex, status);
          continue;
        }
      }

      console.log('📨 問い合わせページ:', contactUrl);
      await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });

      // 2. フォーム構造解析
      const formSchema = await analyzeContactFormWithAI(page);
      if (!formSchema) {
        lastResult = 'form_schema_error';
        lastErrorMsg = 'フォーム構造を解析できませんでした';
        status = 'Failed';

        console.warn('❌ フォーム構造解析に失敗');

        // Slack 通知（フォーム構造解析失敗）
        await notifySlack(
          `[contact-attack-bot] ❌ フォーム解析失敗\n` +
            `会社名: ${contact.companyName}\n` +
            `問い合わせURL: ${contactUrl}\n` +
            `row: ${contact.rowIndex}\n` +
            `エラー: ${lastErrorMsg}`
        );
      } else {
        console.log('🧾 form schema:', JSON.stringify(formSchema, null, 2));

        // 3. フォーム自動入力（送信ボタンは押さない実装）
        const filledSummary =
          (await fillContactForm(page, formSchema, senderInfo, fixedMessage)) ||
          [];

        // 3.5 入力した質問項目と内容を FormLogs に出力
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
        status = 'Success'; // 「入力成功」で Success 扱い
      }
    } catch (err) {
      console.error('💥 Error while processing contact:', err);
      lastResult = 'exception';
      lastErrorMsg = String(err);
      status = 'Failed';

      // Slack 通知（予期しない例外）
      await notifySlack(
        `[contact-attack-bot] 🔴 例外発生\n` +
          `会社名: ${contact.companyName}\n` +
          `siteUrl: ${contact.siteUrl}\n` +
          `contactUrl: ${contactUrl || '(未決定)'}\n` +
          `row: ${contact.rowIndex}\n` +
          `エラー: ${lastErrorMsg}`
      );
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
