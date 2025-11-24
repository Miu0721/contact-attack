// src/contact-form-filler.mjs

// 「お問い合わせ種別」で選びたいラベル
// 案件のご案内系なら '案件のご依頼' にしておく
const CATEGORY_LABEL = '案件のご依頼';

/**
 * formSchema: analyzeContactFormWithAI が返す { fields: [...] }
 * senderInfo: { name, nameKana, email, company, department, phone }
 * fixedMessage: 本文
 */
export async function fillContactForm(page, formSchema, senderInfo, fixedMessage) {
  if (!formSchema || !Array.isArray(formSchema.fields)) {
    console.warn('fillContactForm: 無効な formSchema');
    return;
  }

  const filledSummary = [];

  // reCAPTCHA など「私はロボットではありません」を検出してログに残す
  const recaptchaSelectors = [
    'iframe[src*="google.com/recaptcha"]',
    'div.g-recaptcha',
    'div.recaptcha',
    'input[aria-label*="not a robot" i]',
    'input[aria-label*="ロボットではありません"]',
  ];
  let recaptchaFound = '';
  for (const sel of recaptchaSelectors) {
    const handle = await page.$(sel);
    if (handle) {
      recaptchaFound = sel;
      break;
    }
  }
  if (recaptchaFound) {
    filledSummary.push({
      role: 'captcha',
      type: 'recaptcha',
      selector: recaptchaFound,
      label: 'reCAPTCHA detected',
      nameAttr: '',
      idAttr: '',
      value: 'manual_action_required',
    });
    console.log('🛡️ reCAPTCHA/anti-bot 要素を検出:', recaptchaFound);
  }

  // 画像認証・キャプチャ入力欄らしきものを検出（値は入れずにログのみ）
  try {
    const imageCaptchas =
      (await page.$$eval('input, textarea', (elems) => {
        const keywords = [
          'captcha',
          '認証コード',
          '確認コード',
          'セキュリティコード',
          '画像認証',
          '画像の文字',
          '画像に表示',
        ];
        const results = [];

        for (const el of elems) {
          const tag = el.tagName?.toLowerCase() || '';
          const nameAttr = el.getAttribute('name') || '';
          const idAttr = el.id || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const aria = el.getAttribute('aria-label') || '';
          const labelText = (() => {
            if (idAttr) {
              const lbl = document.querySelector(`label[for="${idAttr}"]`);
              if (lbl) return lbl.innerText.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel) return parentLabel.innerText.trim();
            return '';
          })();

          const combined = (
            `${nameAttr} ${idAttr} ${placeholder} ${aria} ${labelText}`
          ).toLowerCase();

          if (keywords.some((k) => combined.includes(k.toLowerCase()))) {
            const selector = idAttr
              ? `#${idAttr}`
              : nameAttr
                ? `${tag}[name="${nameAttr}"]`
                : tag || 'input';

            results.push({
              selector,
              label: labelText || placeholder || aria || '',
              nameAttr,
              idAttr,
              type: tag || 'input',
            });
          }
        }

        return results;
      })) || [];

    for (const info of imageCaptchas) {
      filledSummary.push({
        role: 'captcha',
        type: 'image_captcha',
        selector: info.selector,
        label: info.label,
        nameAttr: info.nameAttr,
        idAttr: info.idAttr,
        value: 'manual_action_required',
      });
      console.log('🛡️ 画像認証/キャプチャ入力欄を検出:', info.selector);
    }
  } catch (_e) {
    // ignore detection errors
  }

  for (const f of formSchema.fields) {
    const role = f.role;
    const nameAttr = f.nameAttr || '';
    const idAttr = f.idAttr || '';
    const type = (f.type || 'text').toLowerCase();
    const label = f.label || '';

    if (!role) continue;

    // -------------------------
    // セレクタ候補を type ごとに作る
    // -------------------------
    const selectors = [];

    if (type === 'checkbox') {
      if (nameAttr) selectors.push(`input[type="checkbox"][name="${nameAttr}"]`);
      if (idAttr)   selectors.push(`#${idAttr}`);
      if (!selectors.length) selectors.push('input[type="checkbox"]');
    } else if (type === 'radio') {
      if (nameAttr) selectors.push(`input[type="radio"][name="${nameAttr}"]`);
      if (idAttr)   selectors.push(`#${idAttr}`);
      if (!selectors.length) selectors.push('input[type="radio"]');
    } else if (type === 'select') {
      if (nameAttr) selectors.push(`select[name="${nameAttr}"]`);
      if (idAttr)   selectors.push(`#${idAttr}`);
      if (!selectors.length) selectors.push('select');
    } else if (type === 'textarea') {
      if (nameAttr) selectors.push(`textarea[name="${nameAttr}"]`);
      if (idAttr)   selectors.push(`#${idAttr}`);
      if (!selectors.length) selectors.push('textarea');
    } else {
      // 通常の input 系
      if (nameAttr) selectors.push(`input[name="${nameAttr}"]`);
      if (idAttr)   selectors.push(`#${idAttr}`);
      if (!selectors.length) selectors.push(`input[type="${type}"]`);
    }

    // -------------------------
    // 1️⃣ チェックボックス
    // -------------------------
    if (type === 'checkbox') {
      let clicked = false;
      for (const sel of selectors) {
        try {
          await page.check(sel, { force: true });
          console.log(`☑️ Checked checkbox for role="${role}" via ${sel}`);
          filledSummary.push({
            role,
            type,
            selector: sel,
            label,
            nameAttr,
            idAttr,
            value: 'checked',
          });
          clicked = true;
          break;
        } catch (e) {
          console.warn(`⚠️ Failed to check checkbox ${sel} for role="${role}":`, e.message);
        }
      }
      if (!clicked) {
        console.warn(
          `⚠️ チェックボックスをクリックできませんでした role="${role}" name="${nameAttr}" id="${idAttr}"`
        );
      }
      continue;
    }

    // -------------------------
    // 2️⃣ role から value を決める
    // -------------------------
    let value = '';

    if (role === 'name')        value = senderInfo.name || '';
    if (role === 'name_kana')   value = senderInfo.nameKana || '';
    if (role === 'first_name')       value = senderInfo.firstName || senderInfo.name || '';
    if (role === 'last_name')        value = senderInfo.lastName || senderInfo.name || '';
    if (role === 'first_name_kana')  value = senderInfo.firstNameKana || senderInfo.nameKana || '';
    if (role === 'last_name_kana')   value = senderInfo.lastNameKana || senderInfo.nameKana || '';
    if (role === 'email')       value = senderInfo.email || '';
    if (role === 'company')     value = senderInfo.company || '';
    if (role === 'department')  value = senderInfo.department || '';
    if (role === 'phone')       value = senderInfo.phone || '';
    if (role === 'company_phone') value = senderInfo.companyPhone || senderInfo.phone || '';
    if (role === 'personal_phone') value = senderInfo.personalPhone || senderInfo.phone || '';
    if (role === 'title')       value = senderInfo.title || '';
    if (role === 'referral')    value = senderInfo.referral || '';
    if (role === 'gender')      value = senderInfo.gender || '';
    if (role === 'postal_code') value = senderInfo.postalCode || '';
    if (role === 'prefecture')  value = senderInfo.prefecture || '';
    if (role === 'address')     value = senderInfo.address || '';
    if (role === 'age')         value = senderInfo.age || '';
    if (role === 'body')        value = fixedMessage || '';

    // お問い合わせ種別（カテゴリ）は固定ラベル
    if (role === 'category' || role === 'inquiry_category')
      value = senderInfo.inquiryCategory || CATEGORY_LABEL;

    // select / radio 以外で value が空ならスキップ
    if (!value && type !== 'select' && type !== 'radio') continue;

    let filled = false;

    // -------------------------
    // 3️⃣ radio（ラジオボタン）
    // -------------------------
    if (type === 'radio') {
      for (const sel of selectors) {
        try {
          // 同じ name のラジオグループ全体を見る
          const matchedValue = await page.evaluate(
            ({ selector, desiredLabel }) => {
              const inputs = Array.from(document.querySelectorAll(selector))
                .filter(el => el instanceof HTMLInputElement);
              if (!inputs.length) return null;

              // ラベルテキストを取るヘルパー
              const getLabelText = (input) => {
                const id = input.id;
                if (id) {
                  const lbl = document.querySelector(`label[for="${id}"]`);
                  if (lbl) return lbl.innerText.trim();
                }
                const parentLabel = input.closest('label');
                if (parentLabel) return parentLabel.innerText.trim();
                return '';
              };

              // まずは desiredLabel と一致 / 部分一致するラジオを探す
              if (desiredLabel) {
                const exact = inputs.find(input => getLabelText(input) === desiredLabel);
                if (exact) return exact.value || exact.id || 'INDEX:' + inputs.indexOf(exact);

                const partial = inputs.find(input =>
                  getLabelText(input).includes(desiredLabel)
                );
                if (partial) return partial.value || partial.id || 'INDEX:' + inputs.indexOf(partial);
              }

              // 何もマッチしなければ、最初の有効なラジオを返す
              const first = inputs.find(input => !input.disabled);
              if (!first) return null;
              return first.value || first.id || 'INDEX:0';
            },
            { selector: sel, desiredLabel: value }
          );

          if (!matchedValue) continue;

          // "INDEX:n" の場合は index を使ってクリック、それ以外は value とみなす
          if (matchedValue.startsWith('INDEX:')) {
            const index = Number(matchedValue.replace('INDEX:', ''));
            const handles = await page.$$(sel);
            if (handles[index]) {
              await handles[index].check({ force: true });
              console.log(
                `🔘 Checked radio(index=${index}) for role="${role}" via ${sel}`
              );
              filledSummary.push({
                role,
                type,
                selector: sel,
                label,
                nameAttr,
                idAttr,
                value: matchedValue,
              });
              filled = true;
              break;
            }
          } else {
            // value で選択
            await page.selectOption(
              // selectOption は使えないので、evaluate でチェックする
              // → value で再検索して check
              // ここではもう一度 evaluate して check を true にする
              // （Playwright の API だけだと group 指定がやや面倒なので JS 側で完結）
              await (async () => {
                await page.evaluate(
                  ({ selector, val }) => {
                    const inputs = Array.from(
                      document.querySelectorAll(selector)
                    ).filter(el => el instanceof HTMLInputElement);
                    for (const input of inputs) {
                      if (input.value === val) {
                        input.checked = true;
                        break;
                      }
                    }
                  },
                  { selector: sel, val: matchedValue }
                );
              })()
            );
            console.log(
              `🔘 Checked radio(value="${matchedValue}") for role="${role}" via ${sel}`
            );
            filledSummary.push({
              role,
              type,
              selector: sel,
              label,
              nameAttr,
              idAttr,
              value: matchedValue,
            });
            filled = true;
            break;
          }
        } catch (e) {
          console.warn(`⚠️ Failed to select radio for ${sel} role="${role}":`, e.message);
        }
      }

      if (!filled) {
        console.warn(
          `⚠️ radio に値を設定できませんでした role="${role}" name="${nameAttr}" id="${idAttr}"`
        );
      }
      continue;
    }

    // -------------------------
    // 4️⃣ select（プルダウン）
    // -------------------------
    if (type === 'select') {
      for (const sel of selectors) {
        try {
          const handle = await page.$(sel);
          if (!handle) continue;

          // ラベルでマッチする option を探す（正しい evaluate の呼び方）
          const matchedValue = await page.evaluate(
            ({ selector, label }) => {
              const el = document.querySelector(selector);
              if (!el || !(el instanceof HTMLSelectElement)) return null;

              const options = Array.from(el.options);
              const exact = options.find(o => o.text.trim() === label);
              if (exact) return exact.value;

              const partial = options.find(o => o.text.includes(label));
              if (partial) return partial.value;

              return null;
            },
            { selector: sel, label: value }
          );

          if (matchedValue) {
            await page.selectOption(sel, matchedValue);
            console.log(`🔽 Selected "${value}" for role="${role}" via ${sel}`);
            filledSummary.push({
              role,
              type,
              selector: sel,
              label,
              nameAttr,
              idAttr,
              value: matchedValue || value,
            });
            filled = true;
            break;
          }

          // マッチしなければ、「選択してください」以外の最初の option を選ぶ
          const fallbackValue = await page.evaluate(
            ({ selector }) => {
              const el = document.querySelector(selector);
              if (!el || !(el instanceof HTMLSelectElement)) return null;
              const options = Array.from(el.options).filter(o => {
                const t = o.text.trim();
                return t && !/選択してください|please select/i.test(t);
              });
              return options[0]?.value ?? null;
            },
            { selector: sel }
          );

          if (fallbackValue) {
            await page.selectOption(sel, fallbackValue);
            console.log(
              `🔽 Fallback select (first non-placeholder) for role="${role}" via ${sel}`
            );
            filledSummary.push({
              role,
              type,
              selector: sel,
              label,
              nameAttr,
              idAttr,
              value: fallbackValue,
            });
            filled = true;
            break;
          }
        } catch (e) {
          console.warn(`⚠️ Failed to select option for ${sel} role="${role}":`, e.message);
        }
      }

      if (!filled) {
        console.warn(
          `⚠️ select に値を設定できませんでした role="${role}" name="${nameAttr}" id="${idAttr}"`
        );
      }
      continue; // select はここで完了
    }

    // -------------------------
    // 5️⃣ 通常の input / textarea
    // -------------------------
    for (const sel of selectors) {
      try {
        const handle = await page.$(sel);
        if (!handle) continue;

        await page.fill(sel, value);
        console.log(`✏️ Filled role="${role}" into ${sel}`);
        filledSummary.push({
          role,
          type,
          selector: sel,
          label,
          nameAttr,
          idAttr,
          value,
        });
        filled = true;
        break;
      } catch (e) {
        console.warn(`⚠️ Failed to fill ${sel} for role="${role}":`, e.message);
      }
    }

    if (!filled) {
      console.warn(
        `⚠️ どのセレクタでも埋められませんでした role="${role}" name="${nameAttr}" id="${idAttr}"`
      );
    }
  }

  // ★ 送信ボタンはまだ押さない（安全のため）
  // const submit = await page.$('button[type="submit"], input[type="submit"]');
  // if (submit) {
  //   await submit.click();
  //   console.log('🚀 送信ボタンをクリックしました');
  // } else {
  //   console.warn('送信ボタンが見つかりませんでした');
  // }

  return filledSummary;
}

/**
 * 確認画面→送信ボタンがある場合にクリックする。
 * 確認ボタンが無くて直接送信のみの場合も対応。
 * 成功したら true を返す。
 */
// export async function confirmAndSubmit(page) {
//   // ボタンや input[type=submit] の候補
//   const clickFirst = async (selectors, waitNavigation = false) => {
//    for (const sel of selectors) {
//      try {
//        const locator = page.locator(sel).first();
//        if (await locator.count()) {
//          if (waitNavigation) {
//            await Promise.all([
//              locator.click({ timeout: 3000 }),
//              page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {}),
//            ]);
//          } else {
//            await locator.click({ timeout: 3000 });
//          }
//          console.log('🟢 Clicked button:', sel);
//          return true;
//        }
//      } catch (_e) {
//        // 次の候補へ
//      }
//    }
//    return false;
//  };

//  // 1) 確認画面へ進むボタン
//  const confirmSelectors = [
//    'button:has-text("確認")',
//    'button:has-text("確認画面")',
//    'button:has-text("次へ")',
//    'button:has-text("確認する")',
//    'input[type="submit"][value*="確認"]',
//    'input[type="button"][value*="確認"]',
//  ];
//  const movedToConfirm = await clickFirst(confirmSelectors, true);
//  if (movedToConfirm) {
//    console.log('確認画面へ進むボタンをクリックしました');
//    await page.waitForTimeout(1000);
//  }

//  // 2) 送信ボタン
//  const submitSelectors = [
//    'button[type="submit"]',
//    'input[type="submit"]',
//    'button:has-text("送信")',
//    'button:has-text("送信する")',
//    'button:has-text("確認して送信")',
//    'button:has-text("申し込み")',
//    'input[type="button"][value*="送信"]',
//    'input[type="submit"][value*="送信"]',
//  ];
//  const submitted = await clickFirst(submitSelectors, true);
//  if (submitted) {
//    console.log('🚀 送信ボタンをクリックしました');
//  } else {
//    console.log('ℹ️ 送信ボタンは見つかりませんでした');
//  }
//  return submitted;
// }
