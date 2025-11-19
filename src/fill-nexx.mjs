// src/fill-nexx.mjs
import { chromium } from 'playwright';
import { getCompanyInfo } from './lib/notion/getCompanyInfo.mjs';
import { applyTemplate } from './lib/notion/applyTemplate.mjs';

(async () => {
  // 1. ブラウザ起動（挙動確認したいので headless: false）
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 2. 問い合わせフォームURLにアクセス
  await page.goto('https://nexx-inc.jp/contact.html'); // ← 実際のURLでOK
  await page.waitForLoadState('domcontentloaded');

  // 3. Notion から自社情報 & テンプレ取得 → メッセージ生成
  const info = await getCompanyInfo();
  const message = applyTemplate(
    info.template,
    info,
    '御社に関心がありご連絡しました'
  );

  console.log('✉️ 自動入力メッセージ：', message);

  // 4. ページ内でフォーム自動入力 & 送信
  await page.evaluate(({ info, message }) => {
    function autoFillNexxContact() {
      // 1. フォーム要素を取得
      const form = document.querySelector('form');
      if (!form) {
        console.warn('フォームが見つかりませんでした');
        return;
      }

      // 2. お問い合わせ種別（セレクトボックス）
      const selects = form.querySelectorAll('select');
      if (selects[0]) {
        const opt = Array.from(selects[0].options).find((o) =>
          o.text.includes('資料請求')
        );
        if (opt) {
          selects[0].value = opt.value;
          selects[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // 3. テキスト系 input（name / kana / company / 部署 / email / tel）
      const textInputs = form.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"]'
      );

      // Notion の情報を使って埋める（なければデフォルトの文字列）
      if (textInputs[0])
        textInputs[0].value = info.sender || 'テスト 太郎'; // お名前
      if (textInputs[1])
        textInputs[1].value = 'テスト タロウ'; // フリガナ（必要ならNotion側に追加してもOK）
      if (textInputs[2])
        textInputs[2].value = info.company_name || 'テスト株式会社'; // 会社名
      if (textInputs[3])
        textInputs[3].value = info.department || '営業部 マネージャー'; // 部署
      if (textInputs[4])
        textInputs[4].value = info.email || 'test@example.com'; // メール
      if (textInputs[5])
        textInputs[5].value = info.tel || '0312345678'; // 電話番号

      // 4. お問い合わせ内容（textarea）に message を入れる
      const textarea = form.querySelector('textarea');
      if (textarea) {
        textarea.value = message;
      }

      // 5. プライバシーポリシー同意のチェックボックスを ON
      const consentCheckbox = form.querySelector('input[type="checkbox"]');
      if (consentCheckbox && !consentCheckbox.checked) {
        consentCheckbox.click();
      }

      // 6. 送信ボタンをクリック
      const submitButton =
        form.querySelector('button[type="submit"]') ||
        form.querySelector('input[type="submit"]');

      if (submitButton) {
        submitButton.click();
      } else {
        console.warn('送信ボタンが見つかりませんでした');
      }
    }

    autoFillNexxContact();
  }, { info, message });

  // 5. 少し待ってから閉じる（送信後画面を目視確認するため）
  await page.waitForTimeout(5000);
  await browser.close();
})();
