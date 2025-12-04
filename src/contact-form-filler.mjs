// src/contact-form-filler.mjs

// 「お問い合わせ種別」で選びたいラベル
const CATEGORY_LABEL = '案件のご依頼';


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

// メインページにある全てのiframeを取得。　
function allFrames(page) {
  // page.frames() には main frame も含まれる
  return page.frames();
}

function firstUnfilledInput(frame, filledSummary, allowedTags = ['input', 'textarea']) {
  try {
    return frame.evaluateHandle(
      ({ allowed, filled }) => {
        const filledSelectors = new Set((filled || []).map((f) => f.selector));
        const els = Array.from(document.querySelectorAll(allowed.join(','))).filter((el) => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'input') {
            const t = (el.type || '').toLowerCase();
            if (!['text', 'email', 'tel', 'number', 'search', 'url', ''].includes(t)) {
              return false;
            }
          }
          if (el.disabled || el.readOnly) return false;
          const selector = el.name ? `${tag}[name="${el.name}"]` : el.id ? `#${el.id}` : '';
          if (selector && filledSelectors.has(selector)) return false;
          return true;
        });
        return els[0] || null;
      },
      { allowed: allowedTags, filled: filledSummary }
    );
  } catch (_e) {
    return null;
  }
}

// filledSummary に複数ロールを展開して記録する共通ヘルパ
function pushFilledSummary(filledSummary, meta, payload = {}) {
  const base = { ...meta, ...payload };
  const roles = Array.isArray(meta.roles) ? meta.roles.filter(Boolean) : [];
  if (roles.length > 1) {
    roles.forEach((r) => filledSummary.push({ ...base, role: r }));
  } else {
    filledSummary.push(base);
  }
}

function valueForRole(role, senderInfo, message) {
  const postalCode1 = senderInfo.postalCode1 || '';
  const postalCode2 = senderInfo.postalCode2 || '';
  const phone1 = senderInfo.phone1 || '';
  const phone2 = senderInfo.phone2 || '';
  const phone3 = senderInfo.phone3 || '';
  const combinedPostalCode = [postalCode1, postalCode2].filter(Boolean).join('-');
  const combinedPhone = [phone1, phone2, phone3].filter(Boolean).join('-');
  const combinedAddress = [
    senderInfo.city || '',
    senderInfo.town || '',
    senderInfo.street || '',
    senderInfo.building || '',
  ]
    .filter(Boolean)
    .join('');


  // 氏名まわり
  if (role === 'name') {
    return senderInfo.name || '';
  }
  if (role === 'lastName') {
    return senderInfo.lastName || senderInfo.name || '';
  }
  if (role === 'firstName') {
    return senderInfo.firstName || senderInfo.name || '';
  }
  if (role === 'nameKana') {
    return senderInfo.nameKana || '';
  }
  if (role === 'lastNameKana') {
    return senderInfo.lastNameKana || senderInfo.nameKana || '';
  }
  if (role === 'firstNameKana') {
    return senderInfo.firstNameKana || senderInfo.nameKana || '';
  }

  // 旧 snake_case 互換（AI 側の role は基本ここには来ない想定だけど一応）
  if (role === 'name_kana') return senderInfo.nameKana || '';
  if (role === 'first_name') return senderInfo.firstName || senderInfo.name || '';
  if (role === 'last_name') return senderInfo.lastName || senderInfo.name || '';
  if (role === 'first_name_kana') return senderInfo.firstNameKana || senderInfo.nameKana || '';
  if (role === 'last_name_kana') return senderInfo.lastNameKana || senderInfo.nameKana || '';

  // 連絡先系
  if (role === 'email') {
    return senderInfo.email || '';
  }
  if (role === 'phone') {
    return combinedPhone || senderInfo.phone || '';
  }
  if (role === 'personalPhone' || role === 'personal_phone') {
    return senderInfo.personalPhone || combinedPhone || senderInfo.phone || '';
  }

  // 会社情報系
  if (role === 'company-name' || role === 'company_name' || role === 'companyName') {
    return senderInfo.company || senderInfo.companyName || '';
  }
  if (role === 'department') {
    return senderInfo.department || '';
  }
  if (role === 'companyType' || role === 'company_type') {
    return senderInfo.companyType || '';
  }
  if (role === 'position') {
    return senderInfo.position || '';
  }
  if (role === 'companyTopUrl') {
    return (
      senderInfo.companyTopUrl ||
      senderInfo.companyUrl ||
      senderInfo.companyTopURL ||
      ''
    );
  }
  // 旧 role 互換
  if (role === 'company') return senderInfo.company || '';
  if (role === 'company_phone') {
    return senderInfo.companyPhone || senderInfo.phone || '';
  }
  if (role === 'organization') {
    return senderInfo.company || senderInfo.organization || '';
  }

  // プロファイル系
  if (role === 'referral') {
    return senderInfo.referral || '';
  }
  if (role === 'gender') {
    return senderInfo.gender || '';
  }
  if (role === 'age') {
    return senderInfo.age || '';
  }

  // 住所系
  if (role === 'postalCode1' || role === 'postal_code1') {
    return postalCode1 || '';
  }
  if (role === 'postalCode2' || role === 'postal_code2') {
    return postalCode2 || '';
  }
  if (role === 'postalCode' || role === 'postal_code') {
    return combinedPostalCode || '';
  }
  if (role === 'phone1') {
    return phone1 || '';
  }
  if (role === 'phone2') {
    return phone2 || '';
  }
  if (role === 'phone3') {
    return phone3 || '';
  }
  if (role === 'prefecture') {
    return senderInfo.prefecture || '';
  }
  if (role === 'address') {
    return combinedAddress || senderInfo.address || '';
  }

  if (role === 'inquiryType') {
    return senderInfo.inquiryType || CATEGORY_LABEL;
  }

  // 件名・本文
  if (role === 'subject') {
    return senderInfo.subject || '';
  }
  if (role === 'message') {
    return message || senderInfo.message || '';
  }

  // "other" や未知の role は空文字
  return '';
}


// ラベルなどから推測して値を埋める簡易フォールバック
function valueFromLabelFallback(label, senderInfo, message) {
  const text = (label || '').toLowerCase();
  if (!text) return '';
  const combinedPostalCode = [senderInfo.postalCode1 || '', senderInfo.postalCode2 || '']
    .filter(Boolean)
    .join('-');
  const combinedPhone = [senderInfo.phone1 || '', senderInfo.phone2 || '', senderInfo.phone3 || '']
    .filter(Boolean)
    .join('-');
  const combinedAddress = [
    senderInfo.prefecture || '',
    senderInfo.city || '',
    senderInfo.town || '',
    senderInfo.street || '',
    senderInfo.building || '',
  ]
    .filter(Boolean)
    .join('');

  if (text.includes('氏名') || text.includes('名前')) return senderInfo.name || '';
  if (text.includes('メール') || text.includes('email')) return senderInfo.email || '';
  if (text.includes('電話') || text.includes('tel')) return combinedPhone || senderInfo.phone || '';
  if ((text.includes('法人') && text.includes('個人')) || text.includes('法人／個人')) {
    return senderInfo.companyType || '';
  }
  if (text.includes('会社') || text.includes('法人') || text.includes('組織')) {
    return senderInfo.company || senderInfo.organization || '';
  }
  if (text.includes('部署') || text.includes('所属')) return senderInfo.department || '';
  if (text.includes('役職') || text.includes('肩書')) return senderInfo.position || '';
  if (text.includes('郵便') || text.includes('住所') || text.includes('所在地')) {
    return combinedPostalCode || combinedAddress || senderInfo.address || '';
  }
  if (text.includes('件名') || text.includes('タイトル') || text.includes('subject')) {
    return senderInfo.subject || '';
  }
  if (text.includes('内容') || text.includes('message') || text.includes('問い合わせ')) {
    return message || '';
  }
  return '';
}



async function fillCheckbox(page, selectors, meta, filledSummary) {
  for (const frame of allFrames(page)) {
    for (const sel of selectors) {
      try {
        const targetInfo = await frame.evaluate(
          ({ selector, desiredLabel }) => {
            const inputs = Array.from(document.querySelectorAll(selector)).filter(
              (el) => el instanceof HTMLInputElement
            );
            if (!inputs.length) return null;

            const getLabelText = (input) => {
              const id = input.id;
              if (id) {
                const lbl = document.querySelector(`label[for="${id}"]`);
                if (lbl) {
                  const fullLabel = lbl.textContent?.trim() || '';
                  if (fullLabel) return fullLabel;
                }
              }
              const parentLabel = input.closest('label');
              if (parentLabel) {
                const fullLabel = parentLabel.textContent?.trim() || '';
                if (fullLabel) return fullLabel;
              }
              const parent = input.parentElement;
              if (parent) {
                const text = parent.textContent?.trim() || '';
                if (text) return text;
              }
              return '';
            };

            const options = inputs.map((input, idx) => ({
              index: idx,
              value: input.value || '',
              id: input.id || '',
              name: input.name || '',
              label: getLabelText(input) || input.getAttribute('aria-label') || '',
              disabled: !!input.disabled,
            }));

            const norm = (s) => (s || '').trim().toLowerCase();
            const desired = norm(desiredLabel);
            let candidate =
              options.find((o) => desired && norm(o.label) === desired) ||
              options.find((o) => desired && norm(o.label).includes(desired)) ||
              options.find((o) => !o.disabled) ||
              options[0];
            if (!candidate) return null;

            const inputEl = inputs[candidate.index];
            const label = inputEl
              ? getLabelText(inputEl) || inputEl.getAttribute('aria-label') || ''
              : '';

            return {
              ...candidate,
              label,
            };
          },
          { selector: sel, desiredLabel: meta.desiredLabel || '' }
        );

        const handles = await frame.$$(sel);
        const handle = targetInfo ? handles[targetInfo.index] : handles[0];
        if (!handle) continue;

        await handle.check({ force: true });
        const choiceLabel =
          targetInfo?.label ||
          targetInfo?.value ||
          targetInfo?.id ||
          targetInfo?.name ||
          'checked';

        console.log(
          `☑️ Checked checkbox for role="${meta.role}" via ${sel} (choice="${choiceLabel}") (frame: ${frame.url()})`
        );
        pushFilledSummary(filledSummary, meta, { selector: sel, value: choiceLabel });
        return true;
      } catch (_e) {
        // try next selector/frame
      }
    }
  }

  console.warn(
    `⚠️ チェックボックスをクリックできませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function selectRadio(page, selectors, value, meta, filledSummary) {
  for (const frame of allFrames(page)) {
    for (const sel of selectors) {
      try {
        const choice = await frame.evaluate(
          ({ selector, desiredLabel }) => {
            const inputs = Array.from(document.querySelectorAll(selector)).filter(
              (el) => el instanceof HTMLInputElement && el.type === 'radio'
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

            const norm = (s) => (s || '').trim().toLowerCase();
            const options = inputs.map((input, idx) => ({
              index: idx,
              value: input.value || '',
              id: input.id || '',
              name: input.name || '',
              label: getLabelText(input) || '',
              disabled: !!input.disabled,
            }));

            const desired = norm(desiredLabel);
            if (desired) {
              const exact =
                options.find((o) => norm(o.label) === desired) ||
                options.find((o) => norm(o.value) === desired);
              if (exact) return exact;

              const partial =
                options.find((o) => norm(o.label).includes(desired)) ||
                options.find((o) => norm(o.value).includes(desired));
              if (partial) return partial;
            }

            const firstEnabled = options.find((o) => !o.disabled);
            return firstEnabled || options[0];
          },
          { selector: sel, desiredLabel: value }
        );

        if (!choice) continue;

        const handles = await frame.$$(sel);
        const handle = handles[choice.index];
        if (handle) {
          await handle.check({ force: true });
          const choiceLabel =
            choice.label || choice.value || choice.id || choice.name || 'selected';
          console.log(
            `🔘 Checked radio(index=${choice.index}) for role="${meta.role}" via ${sel} (choice="${choiceLabel}") (frame: ${frame.url()})`
          );
          pushFilledSummary(filledSummary, meta, {
            selector: sel,
            value: choiceLabel,
          });
          return true;
        }
      } catch (_e) {
        // try next
      }
    }
  }

  console.warn(
    `⚠️ radio に値を設定できませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function selectOption(page, selectors, value, meta, filledSummary) {
  for (const frame of allFrames(page)) {
    for (const sel of selectors) {
      try {
        // セレクタが存在しない frame はスキップ
        const handle = await frame.$(sel);
        if (!handle) continue;

        // ① ラベル(value 引数)から一致する option を探す（テキストベース）
        const matched = await frame.evaluate(
          ({ selector, label }) => {
            const el = document.querySelector(selector);
            if (!el || !(el instanceof HTMLSelectElement)) return null;

            const options = Array.from(el.options).map((o) => ({
              value: o.value,
              label: o.textContent.trim(),
            }));

            // 完全一致
            let found = options.find((o) => o.label === label);
            if (found) return found;

            // 部分一致
            found = options.find((o) => o.label.includes(label));
            if (found) return found;

            return null;
          },
          { selector: sel, label: value }
        );

        if (matched) {
          // value で実際に select する
          await frame.selectOption(sel, matched.value);

          console.log(
            `🔽 Selected "${matched.label}" (value="${matched.value}") for role="${meta.role}" via ${sel} (frame: ${frame.url()})`
          );

          // filledSummary には「人間が見るラベル」を優先して残す
          pushFilledSummary(filledSummary, meta, {
            selector: sel,
            value: matched.label,      // 表示テキスト
            optionValue: matched.value // HTML の value 属性（おまけ）
          });

          return true;
        }

        // ② fallback: 「選択してください」以外の最初の option を選ぶ
        const fallback = await frame.evaluate(
          ({ selector }) => {
            const el = document.querySelector(selector);
            if (!el || !(el instanceof HTMLSelectElement)) return null;

            const options = Array.from(el.options)
              .map((o) => ({
                value: o.value,
                label: o.textContent.trim(),
              }))
              .filter((o) => {
                const t = o.label;
                return t && !/選択してください|please select/i.test(t);
              });

            return options[0] || null;
          },
          { selector: sel }
        );

        if (fallback) {
          await frame.selectOption(sel, fallback.value);

          console.log(
            `🔽 Fallback select "${fallback.label}" (value="${fallback.value}") for role="${meta.role}" via ${sel} (frame: ${frame.url()})`
          );

          pushFilledSummary(filledSummary, meta, {
            selector: sel,
            value: fallback.label,
            optionValue: fallback.value,
            isFallback: true
          });

          return true;
        }
      } catch (_e) {
        // この selector / frame はあきらめて次へ
      }
    }
  }

  console.warn(
    `⚠️ select に値を設定できませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  return false;
}

async function fillTextField(page, selectors, value, meta, filledSummary) {
  for (const frame of allFrames(page)) {
    for (const sel of selectors) {
      try {
        const handle = await frame.$(sel);
        if (!handle) continue;

        await frame.fill(sel, value);
        console.log(`✏️ Filled role="${meta.role}" into ${sel} (frame: ${frame.url()})`);
        pushFilledSummary(filledSummary, meta, { selector: sel, value });
        return true;
      } catch (_e) {
        // try next
      }
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
  let orderCounter = 1;

  // reCAPTCHA / 画像認証検出は無効化

  for (const f of formSchema.fields) {
    const roles = Array.isArray(f.roles)
      ? (f.roles || []).filter(Boolean).map((r) => String(r))
      : Array.isArray(f.role)
      ? (f.role || []).filter(Boolean).map((r) => String(r))
      : f.role
      ? [String(f.role)]
      : [];

    const role = roles[0] || '';
    const nameAttr = f.nameAttr || '';
    const idAttr = f.idAttr || '';
    const type = (f.type || 'text').toLowerCase();
    const label = f.label || '';

    // roleがなければ、次のフィールドへ
    if (!role) continue;

    const selectors = selectorsForField(type, nameAttr, idAttr);
    const preferredOption =
      f.preferredOption || f.preferredOptionLabel || f.choiceToSelect || '';

    // ---- ここから「複数 role 対応」 ----

    // まずメイン role の値
    let primaryValue = valueForRole(role, senderInfo, message);
    if (primaryValue != null && typeof primaryValue !== 'string') {
      primaryValue = String(primaryValue);
    }

    // すべての roles についての値一覧（ログ用 & 結合用）
    const multiValue = [];
    for (const r of roles) {
      const raw = valueForRole(r, senderInfo, message);
      if (raw == null || raw === '') continue;
      multiValue.push({
        role: r,
        value: String(raw),
      });
    }

    // 実際にフィールドへ入れる value を決定
    let value = preferredOption || primaryValue || '';

    // text / textarea の場合、roles が複数あれば「まとめて 1 つの文字列」に結合
    if (!preferredOption && multiValue.length > 1 && type !== 'select' && type !== 'radio' && type !== 'checkbox') {
      value = multiValue.map((m) => m.value).join(' ・ ');
    }

    // それでも value が空なら、text/textarea 系はラベルからフォールバック
    if (!value && type !== 'select' && type !== 'radio' && type !== 'checkbox') {
      value = valueFromLabelFallback(label, senderInfo, message);
    }

    // まだ value が無くて text 系なら、このフィールドは諦める（other はサマリに残す）
    if (!value && type !== 'select' && type !== 'radio' && type !== 'checkbox') {
      if (role === 'other') {
        const meta = {
          role,
          roles,
          type,
          label,
          nameAttr,
          idAttr,
          order: orderCounter++,
          desiredLabel: preferredOption,
          multiValue: multiValue.length ? multiValue : undefined,
        };
        pushFilledSummary(filledSummary, meta, { selector: '', value: '' });
      }
      continue;
    }

    // 念のため string に統一
    if (value != null && typeof value !== 'string') {
      value = String(value);
    }

    const meta = {
      role,
      roles,
      type,
      label,
      nameAttr,
      idAttr,
      order: orderCounter++,
      desiredLabel: preferredOption,
      multiValue: multiValue.length ? multiValue : undefined, // ★ ここに複数値を残す
    };

    // ---- ここまで「複数 role 対応」 ----

    if (type === 'checkbox') {
      await fillCheckbox(page, selectors, meta, filledSummary);
      continue;
    }

    if (type === 'radio') {
      // radio は 1 個しか選べないので、結局 value は 1 つだけ使う
      await selectRadio(page, selectors, value, meta, filledSummary);
      continue;
    }

    if (type === 'select') {
      // select も 1 個だけ
      await selectOption(page, selectors, value, meta, filledSummary);
      continue;
    }

    const success = await fillTextField(page, selectors, value, meta, filledSummary);
    if (!success) {
      // 最後の手段: まだ埋まっていない text/textarea の先頭を埋める
      for (const frame of allFrames(page)) {
        const handle = await firstUnfilledInput(frame, filledSummary);
        if (!handle) continue;
        try {
          const selector = await frame.evaluate((el) => {
            if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
            if (el.id) return `#${el.id}`;
            return el.tagName.toLowerCase();
          }, handle);
          await frame.fill(selector, value);
          console.log(
            `✏️ Fallback filled role="${meta.role}" into first free input ${selector} (frame: ${frame.url()})`
          );
          pushFilledSummary(filledSummary, meta, { selector, value });
          break;
        } catch (_e) {
          // try next frame
        }
      }
    }
  }


  return filledSummary;
}
