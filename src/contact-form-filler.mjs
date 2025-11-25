// src/contact-form-filler.mjs

// 「お問い合わせ種別」で選びたいラベル
const CATEGORY_LABEL = '案件のご依頼';
const RECAPTCHA_SELECTORS = [
  'iframe[src*="google.com/recaptcha"]',
  'div.g-recaptcha',
  'div.recaptcha',
  'input[aria-label*="not a robot" i]',
  'input[aria-label*="ロボットではありません"]',
];

const IMAGE_CAPTCHA_KEYWORDS = [
  'captcha',
  '認証コード',
  '確認コード',
  'セキュリティコード',
  '画像認証',
  '画像の文字',
  '画像に表示',
];

function selectorsForField(type, nameAttr, idAttr) {
  const selectors = [];

  if (type === 'checkbox') {
    if (nameAttr) selectors.push(`input[type="checkbox"][name="${nameAttr}"]`);
    if (idAttr) selectors.push(`#${idAttr}`);
    if (!selectors.length) selectors.push('input[type="checkbox"]');
    return selectors;
  }

  if (type === 'radio') {
    if (nameAttr) selectors.push(`input[type="radio"][name="${nameAttr}"]`);
    if (idAttr) selectors.push(`#${idAttr}`);
    if (!selectors.length) selectors.push('input[type="radio"]');
    return selectors;
  }

  if (type === 'select') {
    if (nameAttr) selectors.push(`select[name="${nameAttr}"]`);
    if (idAttr) selectors.push(`#${idAttr}`);
    if (!selectors.length) selectors.push('select');
    return selectors;
  }

  if (type === 'textarea') {
    if (nameAttr) selectors.push(`textarea[name="${nameAttr}"]`);
    if (idAttr) selectors.push(`#${idAttr}`);
    if (!selectors.length) selectors.push('textarea');
    return selectors;
  }

  if (nameAttr) selectors.push(`input[name="${nameAttr}"]`);
  if (idAttr) selectors.push(`#${idAttr}`);
  if (!selectors.length) selectors.push(`input[type="${type}"]`);
  return selectors;
}

function valueForRole(role, senderInfo, message) {
  if (role === 'name') return senderInfo.name || '';
  if (role === 'name_kana') return senderInfo.nameKana || '';
  if (role === 'first_name') return senderInfo.firstName || senderInfo.name || '';
  if (role === 'last_name') return senderInfo.lastName || senderInfo.name || '';
  if (role === 'first_name_kana') return senderInfo.firstNameKana || senderInfo.nameKana || '';
  if (role === 'last_name_kana') return senderInfo.lastNameKana || senderInfo.nameKana || '';
  if (role === 'email') return senderInfo.email || '';
  if (role === 'company') return senderInfo.company || '';
  if (role === 'department') return senderInfo.department || '';
  if (role === 'phone') return senderInfo.phone || '';
  if (role === 'company_phone') return senderInfo.companyPhone || senderInfo.phone || '';
  if (role === 'personal_phone') return senderInfo.personalPhone || senderInfo.phone || '';
  if (role === 'position') return senderInfo.position || '';
  if (role === 'referral') return senderInfo.referral || '';
  if (role === 'gender') return senderInfo.gender || '';
  if (role === 'postal_code') return senderInfo.postalCode || '';
  if (role === 'prefecture') return senderInfo.prefecture || '';
  if (role === 'address') return senderInfo.address || '';
  if (role === 'age') return senderInfo.age || '';
  if (role === 'message') return message || '';
  if (role === 'category' || role === 'inquiry_category') {
    return senderInfo.inquiryCategory || CATEGORY_LABEL;
  }
  return '';
}

async function detectRecaptcha(page) {
  for (const sel of RECAPTCHA_SELECTORS) {
    const handle = await page.$(sel);
    if (handle) {
      console.log('🛡️ reCAPTCHA/anti-bot 要素を検出:', sel);
      return {
        role: 'captcha',
        type: 'recaptcha',
        selector: sel,
        label: 'reCAPTCHA detected',
        nameAttr: '',
        idAttr: '',
        value: 'manual_action_required',
      };
    }
  }
  return null;
}

async function detectImageCaptchas(page) {
  try {
    return (
      (await page.$$eval(
        'input, textarea',
        (elems, keywords) =>
          elems
            .map((el) => {
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

              const combined = `${nameAttr} ${idAttr} ${placeholder} ${aria} ${labelText}`.toLowerCase();
              const matched = keywords.some((k) => combined.includes(k.toLowerCase()));
              if (!matched) return null;

              const selector = idAttr
                ? `#${idAttr}`
                : nameAttr
                  ? `${tag}[name="${nameAttr}"]`
                  : tag || 'input';

              return {
                selector,
                label: labelText || placeholder || aria || '',
                nameAttr,
                idAttr,
                type: tag || 'input',
              };
            })
            .filter(Boolean),
        IMAGE_CAPTCHA_KEYWORDS
      )) || []
    );
  } catch (_e) {
    return [];
  }
}

async function fillCheckbox(page, selectors, meta, filledSummary) {
  for (const sel of selectors) {
    try {
      await page.check(sel, { force: true });
      console.log(`☑️ Checked checkbox for role="${meta.role}" via ${sel}`);
      filledSummary.push({ ...meta, selector: sel, value: 'checked' });
      return true;
    } catch (e) {
      console.warn(`⚠️ Failed to check checkbox ${sel} for role="${meta.role}":`, e.message);
    }
  }

  console.warn(
    `⚠️ チェックボックスをクリックできませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function selectRadio(page, selectors, value, meta, filledSummary) {
  for (const sel of selectors) {
    try {
      const matchedValue = await page.evaluate(
        ({ selector, desiredLabel }) => {
          const inputs = Array.from(document.querySelectorAll(selector)).filter(
            (el) => el instanceof HTMLInputElement
          );
          if (!inputs.length) return null;

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

          if (desiredLabel) {
            const exact = inputs.find((input) => getLabelText(input) === desiredLabel);
            if (exact) return exact.value || exact.id || 'INDEX:' + inputs.indexOf(exact);

            const partial = inputs.find((input) => getLabelText(input).includes(desiredLabel));
            if (partial) return partial.value || partial.id || 'INDEX:' + inputs.indexOf(partial);
          }

          const first = inputs.find((input) => !input.disabled);
          if (!first) return null;
          return first.value || first.id || 'INDEX:0';
        },
        { selector: sel, desiredLabel: value }
      );

      if (!matchedValue) continue;

      if (matchedValue.startsWith('INDEX:')) {
        const index = Number(matchedValue.replace('INDEX:', ''));
        const handles = await page.$$(sel);
        if (handles[index]) {
          await handles[index].check({ force: true });
          console.log(`🔘 Checked radio(index=${index}) for role="${meta.role}" via ${sel}`);
          filledSummary.push({ ...meta, selector: sel, value: matchedValue });
          return true;
        }
      } else {
        const loc = page.locator(`${sel}[value="${matchedValue}"], ${sel}#${matchedValue}`);
        if (await loc.count()) {
          await loc.first().check({ force: true }).catch(() => loc.first().click({ force: true }));
          console.log(`🔘 Checked radio(value="${matchedValue}") for role="${meta.role}" via ${sel}`);
          filledSummary.push({ ...meta, selector: sel, value: matchedValue });
          return true;
        }

        const changed = await page.evaluate(
          ({ selector, val }) => {
            const inputs = Array.from(document.querySelectorAll(selector)).filter(
              (el) => el instanceof HTMLInputElement
            );
            for (const input of inputs) {
              if (input.value === val || input.id === val) {
                input.checked = true;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
            return false;
          },
          { selector: sel, val: matchedValue }
        );
        if (changed) {
          console.log(`🔘 Checked radio(value="${matchedValue}") for role="${meta.role}" via ${sel}`);
          filledSummary.push({ ...meta, selector: sel, value: matchedValue });
          return true;
        }
      }
    } catch (e) {
      console.warn(`⚠️ Failed to select radio for ${sel} role="${meta.role}":`, e.message);
    }
  }

  console.warn(
    `⚠️ radio に値を設定できませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function selectOption(page, selectors, value, meta, filledSummary) {
  for (const sel of selectors) {
    try {
      const handle = await page.$(sel);
      if (!handle) continue;

      const matchedValue = await page.evaluate(
        ({ selector, label }) => {
          const el = document.querySelector(selector);
          if (!el || !(el instanceof HTMLSelectElement)) return null;

          const options = Array.from(el.options);
          const exact = options.find((o) => o.text.trim() === label);
          if (exact) return exact.value;

          const partial = options.find((o) => o.text.includes(label));
          if (partial) return partial.value;

          return null;
        },
        { selector: sel, label: value }
      );

      if (matchedValue) {
        await page.selectOption(sel, matchedValue);
        console.log(`🔽 Selected "${value}" for role="${meta.role}" via ${sel}`);
        filledSummary.push({ ...meta, selector: sel, value: matchedValue || value });
        return true;
      }

      const fallbackValue = await page.evaluate(
        ({ selector }) => {
          const el = document.querySelector(selector);
          if (!el || !(el instanceof HTMLSelectElement)) return null;
          const options = Array.from(el.options).filter((o) => {
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
          `🔽 Fallback select (first non-placeholder) for role="${meta.role}" via ${sel}`
        );
        filledSummary.push({ ...meta, selector: sel, value: fallbackValue });
        return true;
      }
    } catch (e) {
      console.warn(`⚠️ Failed to select option for ${sel} role="${meta.role}":`, e.message);
    }
  }

  console.warn(
    `⚠️ select に値を設定できませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function fillTextField(page, selectors, value, meta, filledSummary) {
  for (const sel of selectors) {
    try {
      const handle = await page.$(sel);
      if (!handle) continue;

      await page.fill(sel, value);
      console.log(`✏️ Filled role="${meta.role}" into ${sel}`);
      filledSummary.push({ ...meta, selector: sel, value });
      return true;
    } catch (e) {
      console.warn(`⚠️ Failed to fill ${sel} for role="${meta.role}":`, e.message);
    }
  }

  console.warn(
    `⚠️ どのセレクタでも埋められませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

/**
 * formSchema: analyzeContactFormWithAI が返す { fields: [...] }
 * senderInfo: { name, nameKana, email, company, department, phone }
 * message: 本文
 */
export async function fillContactForm(page, formSchema, senderInfo, message) {
  if (!formSchema || !Array.isArray(formSchema.fields)) {
    console.warn('fillContactForm: 無効な formSchema');
    return;
  }

  const filledSummary = [];

  // reCAPTCHA など「私はロボットではありません」を検出してログに残す
  const recaptcha = await detectRecaptcha(page);
  if (recaptcha) {
    filledSummary.push(recaptcha);
  }

  // reCAPTCHA など画像認証を検出してログに残す
  const imageCaptchas = await detectImageCaptchas(page);
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

  for (const f of formSchema.fields) {
    const role = f.role;
    const nameAttr = f.nameAttr || '';
    const idAttr = f.idAttr || '';
    const type = (f.type || 'text').toLowerCase();
    const label = f.label || '';

    // roleがなければ、次のフィールドへ
    if (!role) continue;

    const selectors = selectorsForField(type, nameAttr, idAttr);
    const meta = { role, type, label, nameAttr, idAttr };

    if (type === 'checkbox') {
      await fillCheckbox(page, selectors, meta, filledSummary);
      continue;
    }

    const value = valueForRole(role, senderInfo, message);
    if (!value && type !== 'select' && type !== 'radio') continue;

    if (type === 'radio') {
      await selectRadio(page, selectors, value, meta, filledSummary);
      continue;
    }

    if (type === 'select') {
      await selectOption(page, selectors, value, meta, filledSummary);
      continue;
    }

    await fillTextField(page, selectors, value, meta, filledSummary);
  }

  return filledSummary;
}
