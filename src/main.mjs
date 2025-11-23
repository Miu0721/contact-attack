import { chromium } from 'playwright';
import { findContactPageCandidates } from './url-discovery.mjs';
import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
import { fillContactForm } from './contact-form-filler.mjs';
import { SENDER_INFO, FIXED_MESSAGE, COMPANY_TOP_URL } from './config/sender.mjs';
import { notifySlack } from './lib/slack.mjs';
import {
  loadSenderFromSheet,
  appendFormQuestionsAndAnswers,
} from './config/sender-from-sheet.mjs';

const companyTopUrl =
  COMPANY_TOP_URL || process.env.COMPANY_TOP_URL || 'https://nexx-inc.jp/index.html';

(async () => {
  let browser;

  try {

    const senderFromSheet = await loadSenderFromSheet().catch(() => null);

    // シートに値があればそっち優先、なければ sender.mjs のデフォルト
    const senderInfo =
    senderFromSheet?.senderInfo && senderFromSheet.senderInfo.name
        ? senderFromSheet.senderInfo
        : SENDER_INFO;

    const fixedMessage =
    senderFromSheet?.fixedMessage && senderFromSheet.fixedMessage.trim()
        ? senderFromSheet.fixedMessage
        : FIXED_MESSAGE;

    const companyTopUrl =
    senderFromSheet?.companyTopUrl ||
    COMPANY_TOP_URL ||
    process.env.COMPANY_TOP_URL ||
    'https://nexx-inc.jp/index.html';
    const contactPrompt = senderFromSheet?.contactPrompt || '';


    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    const candidates = await findContactPageCandidates(page, companyTopUrl, contactPrompt);

    if (!candidates.length) {
      const msg = `❌ 問い合わせページURLが見つかりませんでした: ${companyTopUrl}`;
      console.error(msg);
      await notifySlack(`[contact-attack-bot] ${msg}`);
      return;
    }

    let success = false;
    for (const contactUrl of candidates) {
      console.log('📨  問い合わせページ候補にアクセスします:', contactUrl);
      try {
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });
      } catch (navErr) {
        console.warn('⚠️ ページ遷移に失敗:', navErr?.message || navErr);
        continue;
      }

      const formSchema = await analyzeContactFormWithAI(page);

      if (!formSchema) {
        console.warn(`❌ フォーム構造解析に失敗しました: ${contactUrl} (次の候補へ)`);
        continue;
      }

      console.log('🧾 推定フォームスキーマ:');
      console.log(JSON.stringify(formSchema, null, 2));

      const filledSummary =
        (await fillContactForm(page, formSchema, senderInfo, fixedMessage)) || [];

      const captchaEntry = filledSummary.find((f) => f.role === 'captcha');
      if (captchaEntry) {
        console.warn('🛡️ reCAPTCHA/anti-bot を検出したためフォーム入力を中断します');
        try {
          await appendFormQuestionsAndAnswers({
            contactUrl,
            siteUrl: companyTopUrl,
            filledSummary,
            formSchema,
          });
        } catch (logErr) {
          console.warn(
            '⚠️ フォーム質問ログの書き込みに失敗:',
            logErr?.message || logErr
          );
        }
        success = true;
        break;
      }

      if (!filledSummary.length) {
        console.warn('⚠️ 入力サマリが空でした (次の候補へ)');
        continue;
      }

      try {
        await appendFormQuestionsAndAnswers({
          contactUrl,
          siteUrl: companyTopUrl,
          filledSummary,
          formSchema,
        });
      } catch (logErr) {
        console.warn(
          '⚠️ フォーム質問ログの書き込みに失敗:',
          logErr?.message || logErr
        );
      }

      console.log('✅ フォームへの自動入力が完了しました（送信はまだしていません）');
      success = true;
      break;
    }

    if (!success) {
      const msg = `❌ 全候補を試しましたがフォーム入力に失敗しました: ${companyTopUrl}`;
      console.error(msg);
      await notifySlack(`[contact-attack-bot] ${msg}`);
    }
  } catch (err) {
    console.error('🔴 致命的エラー:', err);
    await notifySlack(
      `[contact-attack-bot] 🔴 致命的エラー: ${err.message || String(err)}`
    );
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
