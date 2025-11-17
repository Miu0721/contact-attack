// src/fill-nexx.mjs
import { chromium } from 'playwright';

(async () => {
  // 🔹1. ブラウザ起動（最初は挙動確認したいので headless: false にする）
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 🔹2. Nexx の問い合わせフォームURLにアクセス
  // TODO: 実際のURLに差し替えてね
  await page.goto('https://nexx-inc.jp/contact.html'); // 仮の例

  // ページのロードを待つ
  await page.waitForLoadState('domcontentloaded');

  // 🔹3. ページの中で autoFillNexxContact() を実行
  await page.evaluate(() => {
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
        const opt = Array.from(selects[0].options).find(o =>
          o.text.includes('資料請求')
        );
        if (opt) {
          selects[0].value = opt.value;
          selects[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // 3. テキスト系 input を順番で埋める（name, kana, company, 部署, email, tel の想定）
      const textInputs = form.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"]'
      );

      if (textInputs[0]) textInputs[0].value = 'テスト 太郎';               // お名前
      if (textInputs[1]) textInputs[1].value = 'テスト タロウ';             // フリガナ
      if (textInputs[2]) textInputs[2].value = 'テスト株式会社';           // 会社名・所属先
      if (textInputs[3]) textInputs[3].value = '営業部 マネージャー';     // 役職・部署
      if (textInputs[4]) textInputs[4].value = 'test@example.com';        // メールアドレス
      if (textInputs[5]) textInputs[5].value = '0312345678';              // 電話番号

      // 4. お問い合わせ内容（textarea）
      const textarea = form.querySelector('textarea');
      if (textarea) {
        textarea.value =
          '自動入力テストです。実際に送信する場合は内容を書き換えてください。';
      }

      // 5. プライバシーポリシー同意のチェックボックスを ON にする
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

    // 実行
    autoFillNexxContact();
  });

  // ちょっと様子を見るために数秒待つ
  await page.waitForTimeout(5000);

  await browser.close();
})();
