import { chromium } from 'playwright';
import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
import { fillContactForm /*, confirmAndSubmit */ } from './contact-form-filler.mjs';
import { findContactPageCandidates } from './url-discovery.mjs';


// Sender 情報を Google スプレッドシートから読む
import {
  loadSenderFromSheet,
  appendFormQuestionsAndAnswers,
} from './config/sender-from-sheet.mjs';

import {
  fetchContacts,
  updateContactRowValues,
} from './lib/google/contactsRepo.mjs';

// import { notifySlack } from './lib/slack.mjs';

async function appendFormLogSafe(params) {
  try {
    await appendFormQuestionsAndAnswers(params);
  } catch (logErr) {
    console.warn(
      '⚠️ フォーム質問ログの書き込みに失敗:',
      logErr?.message || logErr
    );
  }
}

// FormLog の概要を Contacts に流し込む処理は撤廃

(async () => {
  // 0. Sender シートから自社情報を読み込み（失敗したら null）
  // Sender シートから情報を取得（失敗したら空オブジェクト/空文字で進む）
  const senderFromSheet = await loadSenderFromSheet().catch((err) => {
    console.warn('Sender シートの読み込みに失敗しました:', err?.message || err);
    return null;
  });

  const senderInfo = senderFromSheet?.senderInfo || {};
  const message =
    senderFromSheet?.message && senderFromSheet.message.trim().length > 0
      ? senderFromSheet.message
      : '';
  const contactPrompt = senderFromSheet?.contactPrompt || '';

  console.log('📨 使用する Sender 情報:', senderInfo);
  console.log(
    '📝 message の先頭30文字:',
    message ? message.slice(0, 30) + '...' : '(空)'
  );

  // 1. Contacts シートからデータを取得
  const contacts = await fetchContacts();

  if (!contacts.length) {
    console.log('Contacts シートにデータがありません');
    return;
  }

  // 2. ブラウザを起動
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  for (const contact of contacts) {
    // すでに処理済みならスキップ
    if (
      contact.status &&
      contact.status !== '' &&
      contact.status !== 'Pending'
    ) {
      console.log(
        `⏩ Skip: ${contact.companyName} (status=${contact.status})`
      );
      continue;
    }

    console.log(
      `🚀 Processing: ${contact.companyName} (row ${contact.rowIndex})`
    );

    const timestamp = new Date().toISOString();
    let runCount = (contact.runCount || 0) + 1;

    let status = 'Failed';
    let lastResult = '';
    let lastErrorMsg = '';
    let contactUrl = contact.contactUrl;
    let filledSummary = [];
    let formSchema = null;

    try {
      // 1. サイトURLをContactsシートから取得
      const baseUrl = contact.siteUrl || contact.contactUrl;
      if (!baseUrl) {
        throw new Error('Site URL / Contact URL が両方空です');
      }

      // 候補URLを取得（指定済み contactUrl を優先、無ければ探索）
      const candidateUrls = contactUrl
        ? [contactUrl]
        : await findContactPageCandidates(page, baseUrl, contactPrompt);

      // コンタクトページが見つからなければ、エラーを出す。
      if (!candidateUrls.length) {
        lastResult = 'form_not_found';
        lastErrorMsg = '問い合わせフォームURLを特定できませんでした';
        status = 'Failed';
        console.warn('❌ 問い合わせページURLが見つからない');

        // slack通知処理
        // await notifySlack(
        //   `[contact-attack-bot] ❌ フォームURL特定失敗\n` +
        //     `会社名: ${contact.companyName}\n` +
        //     `ベースURL: ${baseUrl}\n` +
        //     `row: ${contact.rowIndex}\n` +
        //     `エラー: ${lastErrorMsg}`
        // );

        // Contactsシートを更新（コンタクトページURL）
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
      let success = false;

      for (const candidate of candidateUrls) {
        contactUrl = candidate;
        console.log('📨 問い合わせページを試行:', contactUrl);

        try {
          await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });
        } catch (navErr) {
          console.warn(
            '⚠️ ページ遷移に失敗:',
            navErr?.message || navErr
          );
          lastErrorMsg = navErr?.message || String(navErr);
          continue;
        }

        // コンタクトページのフォーム構造を解析
        formSchema = await analyzeContactFormWithAI(
          page,
          senderInfo,
          message
        );
        if (!formSchema) {
          console.warn('❌ フォーム構造解析に失敗');
          lastResult = 'form_schema_error';
          lastErrorMsg = 'フォーム構造を解析できませんでした';
          continue;
        }

        console.log(
          '🧾 form schema:',
          JSON.stringify(formSchema, null, 2)
        );

        // AIの解析をもとに、フォームを入力
        filledSummary =
          (await fillContactForm(
            page,
            formSchema,
            senderInfo,
            message
          )) || [];
        console.log(
          '🧾 filledSummary:',
          JSON.stringify(filledSummary, null, 2)
        );

        if (filledSummary.length === 0) {
          console.warn('⚠️ 入力サマリが空でした');
          lastResult = 'fill_empty';
          lastErrorMsg = '入力できるフィールドがありませんでした';
          continue;
        }

        await appendFormLogSafe({
          contact,
          contactUrl,
          siteUrl: contact.siteUrl,
          filledSummary,
          formSchema,
        });

        // const captchaEntry = filledSummary.find(
        //   (f) => f.role === 'captcha'
        // );
        // if (captchaEntry) {
        //   lastResult = 'captcha_detected';
        //   lastErrorMsg =
        //     'reCAPTCHA/anti-bot 要素を検出しました（手動対応が必要です）';
        //   status = 'Failed';
        //   success = true; // これ以上のエラー通知を避けるため success として扱う
        //   break;
        // }

        success = true;
        lastResult = 'filled';
        status = 'Success';

        // 送信は安全のため現在無効化
        break;
      }

      // フォームが入力できなかった場合、エラーを出す。
      if (!success) {
        status = 'Failed';
        if (!lastResult) lastResult = 'form_not_filled';

        // await notifySlack(
        //   `[contact-attack-bot] ❌ フォーム入力に失敗\n` +
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

    // 4. シート更新（FormLogs とは分離）
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
    await new Promise((r) =>
      setTimeout(r, 1000 + Math.random() * 2000)
    );
  }

  await browser.close();
})();
