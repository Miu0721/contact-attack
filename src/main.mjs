// import { chromium } from 'playwright';
// import { findContactPageCandidates } from './url-discovery.mjs';
// import { analyzeContactFormWithAI } from './contact-form-analyzer.mjs';
// import { fillContactForm /*, confirmAndSubmit */ } from './contact-form-filler.mjs';
// import { SENDER_INFO, FIXED_MESSAGE, COMPANY_TOP_URL } from './config/sender.mjs';
// // import { notifySlack } from './lib/slack.mjs';
// import {
//   loadSenderFromSheet,
//   appendFormQuestionsAndAnswers,
//   mergeSenderInfo,
// } from './config/sender-from-sheet.mjs';

// const DEFAULT_TOP_URL =
//   COMPANY_TOP_URL || process.env.COMPANY_TOP_URL || 'https://nexx-inc.jp/index.html';

// async function resolveSenderContext() {
//   const senderFromSheet = await loadSenderFromSheet().catch(() => null);
//   const sheetSender = senderFromSheet?.senderInfo || {};
//   const senderInfo = mergeSenderInfo(SENDER_INFO, sheetSender);
//   const fixedMessage = senderFromSheet?.fixedMessage?.trim() || FIXED_MESSAGE;

//   return {
//     senderInfo,
//     fixedMessage,
//     companyTopUrl: senderFromSheet?.companyTopUrl || DEFAULT_TOP_URL,
//     contactPrompt: senderFromSheet?.contactPrompt || '',
//   };
// }

// async function appendFormLogSafe(params) {
//   try {
//     await appendFormQuestionsAndAnswers(params);
//   } catch (logErr) {
//     console.warn('⚠️ フォーム質問ログの書き込みに失敗:', logErr?.message || logErr);
//   }
// }

// async function processCandidates(page, candidates, senderInfo, fixedMessage, companyTopUrl) {
//   for (const contactUrl of candidates) {
//     console.log('📨  問い合わせページ候補にアクセスします:', contactUrl);

//     try {
//       await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });
//     } catch (navErr) {
//       console.warn('⚠️ ページ遷移に失敗:', navErr?.message || navErr);
//       continue;
//     }

//     const formSchema = await analyzeContactFormWithAI(page);
//     if (!formSchema) {
//       console.warn(`❌ フォーム構造解析に失敗しました: ${contactUrl} (次の候補へ)`);
//       continue;
//     }

//     console.log('🧾 推定フォームスキーマ:');
//     console.log(JSON.stringify(formSchema, null, 2));

//     const filledSummary =
//       (await fillContactForm(page, formSchema, senderInfo, fixedMessage)) || [];

//     const captchaEntry = filledSummary.find((f) => f.role === 'captcha');
//     if (captchaEntry) {
//       console.warn('🛡️ reCAPTCHA/anti-bot を検出したためフォーム入力を中断します');
//       await appendFormLogSafe({
//         contactUrl,
//         siteUrl: companyTopUrl,
//         filledSummary,
//         formSchema,
//       });
//       return true;
//     }

//     if (!filledSummary.length) {
//       console.warn('⚠️ 入力サマリが空でした (次の候補へ)');
//       continue;
//     }

//     await appendFormLogSafe({
//       contactUrl,
//       siteUrl: companyTopUrl,
//       filledSummary,
//       formSchema,
//     });

//     console.log('✅ フォームへの自動入力が完了しました（送信はまだしていません）');
//     return true;
//   }

//   return false;
// }

// async function main() {
//   let browser;

//   try {
//     const { senderInfo, fixedMessage, companyTopUrl, contactPrompt } =
//       await resolveSenderContext();

//     browser = await chromium.launch({ headless: false });
//     const page = await browser.newPage();

//     const candidates = await findContactPageCandidates(page, companyTopUrl, contactPrompt);
//     if (!candidates.length) {
//       const msg = `❌ 問い合わせページURLが見つかりませんでした: ${companyTopUrl}`;
//       console.error(msg);
//       // await notifySlack(`[contact-attack-bot] ${msg}`);
//       return;
//     }

//     const success = await processCandidates(
//       page,
//       candidates,
//       senderInfo,
//       fixedMessage,
//       companyTopUrl
//     );

//     if (!success) {
//       const msg = `❌ 全候補を試しましたがフォーム入力に失敗しました: ${companyTopUrl}`;
//       console.error(msg);
//       // await notifySlack(`[contact-attack-bot] ${msg}`);
//     }
//   } catch (err) {
//     console.error('🔴 致命的エラー:', err);
//     // await notifySlack(
//     //   `[contact-attack-bot] 🔴 致命的エラー: ${err.message || String(err)}`
//     // );
//   } finally {
//     if (browser) {
//       await browser.close();
//     }
//   }
// }

// main();
