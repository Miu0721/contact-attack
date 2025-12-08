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

// import { notifySlack } from './lib/slack.mjs';

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
  console.log(
    '📝 message の先頭30文字:',
    message ? message.slice(0, 30) + '...' : '(空)'
  );

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

      const timestamp = new Date().toISOString();
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

          await appendFormLogSafe({
            contact,
            contactUrl,
            siteUrl: contact.siteUrl,
            filledSummary,
            formSchema,
          });

          // success = true;
          // lastResult = submitted ? 'submitted' : 'filled';
          success = true;
          lastResult = 'filled';
          status = 'Success';
          break;
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
