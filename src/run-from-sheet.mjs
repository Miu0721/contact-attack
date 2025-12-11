import { chromium } from 'playwright';
import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
import { fillContactForm } from './contact-form-filler.mjs';
import { findContactPageCandidates } from './url-discovery.mjs';

import {
  loadSenderFromSheet,
  appendFormQuestionsAndAnswers,
} from './config/sender-from-sheet.mjs';

import {
  fetchContacts,
  updateContactRowValues,
} from './lib/google/contactsRepo.mjs';

const appendManualNote = (msg) => {
  const note = '手動対応必須';
  if (!msg) return note;
  return msg.includes(note) ? msg : `${msg} ${note}`;
};

// 日本時間に変換
function getJSTTimestamp() {
  const date = new Date();

  // 日本時間（UTC+9）に変換
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  const Y = jst.getUTCFullYear();
  const M = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const D = String(jst.getUTCDate()).padStart(2, '0');
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');

  return `${Y}/${M}/${D} ${h}:${m}`;
}

// 簡易的に送信ボタンを探してクリックする。成功したら true。
async function trySubmit(page) {
  const clickFirst = async (selectors, waitNavigation = false) => {
    for (const sel of selectors) {
      try {
        const locator = page.locator(sel).first();
        if (await locator.count()) {
          if (waitNavigation) {
            await Promise.all([
              locator.click({ timeout: 3000 }),
              page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}),
            ]);
          } else {
            await locator.click({ timeout: 3000 });
          }
          console.log('🟢 Clicked button:', sel);
          return true;
        }
      } catch (_e) {
        // 次の候補へ
      }
    }
    return false;
  };

  const confirmLabels = ['確認', '確認画面', '次へ', '確認する'];

  // ラベルからセレクタを組み立てる
  const confirmSelectors = confirmLabels.flatMap((label) => [
    `button:has-text("${label}")`,
    // `input[type="submit"][value*="${label}"]`,
    // `input[type="button"][value*="${label}"]`,
  ]);


  const movedToConfirm = await clickFirst(confirmSelectors, true);
  if (movedToConfirm) {
    console.log('確認画面へ進むボタンをクリックしました');
    await page.waitForTimeout(1000);
  } else {
    console.log('確認画面へ進むボタンをクリックできませんでした。');
  }

  // ✅ こっちもラベルのみ
  const submitLabels = [  '送信',
    '送信する',
    '確認して送信',
    '申し込み',
    '申し込む',
    'この内容で送信',
    '上記の内容で送信',
    '内容を送信',
    '登録',
    '登録する'];

  const submitSelectors = submitLabels.flatMap((label) => [
    `button:has-text("${label}")`,
    // `input[type="submit"][value*="${label}"]`,
    // `input[type="button"][value*="${label}"]`,
  ]);


  const submitted = await clickFirst(submitSelectors, true);
  if (submitted) {
    console.log('🚀 送信ボタンをクリックしました');
    return true;
  } else {
    console.log('ℹ️ 送信ボタンは見つかりませんでした');
    return false;
  }
}


async function appendFormLogSafe(params) {
  try {
    await appendFormQuestionsAndAnswers(params);
  } catch (logErr) {
    console.warn('⚠️ フォーム質問ログの書き込みに失敗:', logErr?.message || logErr);
  }
}

export async function runFromSheetJob() {
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


  const contacts = await fetchContacts();
  if (!contacts.length) {
    console.log('Contacts シートにデータがありません');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  try {
    for (const contact of contacts) {
      const hasStatusDone =
        contact.status && contact.status !== '' && contact.status !== 'Pending';
      const hasResult =
        contact.lastResult && String(contact.lastResult).trim() !== '';
      if (hasStatusDone || hasResult) {
        console.log(
          `⏩ Skip: ${contact.companyName} (status=${contact.status}, lastResult=${contact.lastResult})`
        );
        continue;
      }

      console.log(`🚀 Processing: ${contact.companyName} (row ${contact.rowIndex})`);

      const timestamp = getJSTTimestamp();
      let runCount = (contact.runCount || 0) + 1;
      let status = 'Failed';
      let lastResult = '';
      let lastErrorMsg = '';
      let contactUrl = contact.contactUrl;
      let filledSummary = [];
      let formSchema = null;

      try {
        const baseUrl = contact.siteUrl || contact.contactUrl;
        if (!baseUrl) {
          lastResult = 'no_base_url';
          lastErrorMsg = 'Site URL / Contact URL が両方空です';

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

        const candidateUrls = contactUrl
          ? [contactUrl]
          : await findContactPageCandidates(page, baseUrl, contactPrompt);

        if (!candidateUrls.length) {
          lastResult = 'form_not_found';
          lastErrorMsg = '問い合わせフォームURLを特定できませんでした';

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
            console.warn('⚠️ ページ遷移に失敗:', navErr?.message || navErr);
            lastErrorMsg = navErr?.message || String(navErr);
            continue;
          }

          formSchema = await analyzeContactFormWithAI(page, senderInfo, message);
          if (!formSchema) {
            lastResult = 'form_schema_error';
            lastErrorMsg =
              '解析失敗';
            continue;
          }

          filledSummary =
            (await fillContactForm(page, formSchema, senderInfo, message)) || [];
          console.log('🧾 filledSummary:', JSON.stringify(filledSummary, null, 2));

          if (filledSummary.length === 0) {
            lastResult = 'fill_empty';
            lastErrorMsg = '入力できるフィールドがありませんでした（手動対応必須）';
            continue;
          }

          // 送信処理に入る前に入力内容をスプレッドシートへ記録しておく
          await appendFormLogSafe({
            contact,
            contactUrl,
            siteUrl: contact.siteUrl,
            filledSummary,
            formSchema,
          });

          let submitted = false;
          try {
            submitted = await trySubmit(page);
          } catch (submitErr) {
            console.warn('⚠️ 送信処理でエラー:', submitErr?.message || submitErr);
          }

          if (submitted) {
            success = true;
            lastResult = 'submitted';
            status = 'Success';
            break;
          } else {
            lastResult = 'filled';
            lastErrorMsg = '送信ボタンが見つからない / 送信できませんでした';
          }
        }

        if (!success) {
          status = 'Failed';
          if (!lastResult) lastResult = 'form_not_filled';
        }
      } catch (err) {
        console.error('💥 Error while processing contact:', err);
      lastResult = 'exception';
      lastErrorMsg = String(err);
      status = 'Failed';
    }

    if (status !== 'Success') {
      lastErrorMsg = appendManualNote(lastErrorMsg || lastResult || '');
    }

    await updateContactRowValues(contact, {
      contactUrl,
      status,
      lastRunAt: timestamp,
      lastResult,
        lastErrorMsg,
        runCount,
      });

      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFromSheetJob().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
