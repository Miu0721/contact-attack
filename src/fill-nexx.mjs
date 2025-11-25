// // src/fill-nexx.mjs
// import { chromium } from 'playwright';
// import { getCompanyInfo } from './lib/notion/getCompanyInfo.mjs';
// import { applyTemplate } from './lib/notion/applyTemplate.mjs';

// async function fillContactFormOnPage(page, info, message) {
//   await page.evaluate(
//     ({ info: fillInfo, message: fillMessage }) => {
//       const form = document.querySelector('form');
//       if (!form) {
//         console.warn('フォームが見つかりませんでした');
//         return;
//       }

//       const selects = form.querySelectorAll('select');
//       if (selects[0]) {
//         const opt = Array.from(selects[0].options).find((o) =>
//           o.text.includes('資料請求')
//         );
//         if (opt) {
//           selects[0].value = opt.value;
//           selects[0].dispatchEvent(new Event('change', { bubbles: true }));
//         }
//       }

//       const textInputs = form.querySelectorAll(
//         'input[type="text"], input[type="email"], input[type="tel"]'
//       );

//       if (textInputs[0]) textInputs[0].value = fillInfo.sender || 'テスト 太郎';
//       if (textInputs[1]) textInputs[1].value = 'テスト タロウ';
//       if (textInputs[2]) textInputs[2].value = fillInfo.company_name || 'テスト株式会社';
//       if (textInputs[3]) textInputs[3].value = fillInfo.department || '営業部 マネージャー';
//       if (textInputs[4]) textInputs[4].value = fillInfo.email || 'test@example.com';
//       if (textInputs[5]) textInputs[5].value = fillInfo.tel || '0312345678';

//       const textarea = form.querySelector('textarea');
//       if (textarea) {
//         textarea.value = fillMessage;
//       }

//       const consentCheckbox = form.querySelector('input[type="checkbox"]');
//       if (consentCheckbox && !consentCheckbox.checked) {
//         consentCheckbox.click();
//       }

//       const submitButton =
//         form.querySelector('button[type="submit"]') ||
//         form.querySelector('input[type="submit"]');

//       if (submitButton) {
//         submitButton.click();
//       } else {
//         console.warn('送信ボタンが見つかりませんでした');
//       }
//     },
//     { info, message }
//   );
// }

// async function main() {
//   const browser = await chromium.launch({ headless: false });
//   const page = await browser.newPage();

//   await page.goto('https://nexx-inc.jp/contact.html');
//   await page.waitForLoadState('domcontentloaded');

//   const info = await getCompanyInfo();
//   const message = applyTemplate(info.template, info, '御社に関心がありご連絡しました');

//   console.log('✉️ 自動入力メッセージ：', message);

//   await fillContactFormOnPage(page, info, message);

//   await page.waitForTimeout(5000);
//   await browser.close();
// }

// main().catch((err) => {
//   console.error('fill-nexx 実行中にエラーが発生しました:', err);
// });
