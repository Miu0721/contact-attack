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

// フォーム内リンクのクリックを無効化して誤遷移を防ぐ
async function disableFormLinks(page) {
  for (const frame of allFrames(page)) {
    try {
      await frame.evaluate(() => {
        document.querySelectorAll('form a').forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          a.setAttribute('data-disabled-link', 'true');
        });
      });
    } catch (_e) {
      // ignore per-frame failure
    }
  }
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
        return null;
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
  const combinedPhone = [phone1, phone2, phone3].filter(Boolean).join('');
  const combinedAddress = [
    senderInfo.city || '',
    senderInfo.town || '',
    senderInfo.street || '',
    senderInfo.building || '',
  ]
    .filter(Boolean)
    .join('');

  const combinedStreetAddress = [
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

  if (role === 'nameHira') {
    return senderInfo.nameHira || '';
  }
  if (role === 'firstNameHira') {
    return senderInfo.firstNameHira || '';
  }
  if (role === 'lastNameHira') {
    return senderInfo.lastNameHira || '';
  }
  // 連絡先系
  if (role === 'email') {
    return senderInfo.email || '';
  }
  if (role === 'confirmEmail') {
    return senderInfo.confirmEmail || '';
  }

  if (role === 'companyName') {
    return senderInfo.company || senderInfo.companyName || '';
  }

  if (role === 'companyNameKana') {
    return senderInfo.companyNameKana || '';
  }

  if (role === 'department') {
    return senderInfo.department || '';
  }

  if (role === 'phone') {
    return combinedPhone || senderInfo.phone || '';
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

  if (role === 'corporateSiteUrl') {
    return senderInfo.corporateSiteUrl ||'';
  }
  if (role === 'position') {
    return senderInfo.position || '';
  }

  if (role === 'referral') {
    return senderInfo.referral || '';
  }

  if (role === 'gender') {
    return senderInfo.gender || '';
  }

  if (role === 'country') {
    return senderInfo.country || '';
  }

  if (role === 'postalCode1') {
    return postalCode1 || '';
  }
  if (role === 'postalCode2') {
    return postalCode2 || '';
  }
  if (role === 'postalCode') {
    return combinedPostalCode || '';
  }

  if (role === 'prefecture') {
    return senderInfo.prefecture || '';
  }

  if (role === 'city') {
    return senderInfo.city || '';
  }
  if (role === 'town') {
    return senderInfo.town || '';
  }
  if (role === 'street') {
    return senderInfo.street || '';
  }

  if (role === 'building') {
    return senderInfo.building || '';
  }

  if (role === 'address') {
    return combinedAddress || senderInfo.address || '';
  }

  if (role === 'streetAddress') {
    return combinedStreetAddress || '';
  }

  if (role === 'age') {
    return senderInfo.age || '';
  }

  if (role === 'subject') {
    return senderInfo.subject || '';
  }

  if (role === 'inquiryType') {
    return senderInfo.inquiryType || CATEGORY_LABEL;
  }

  if (role === 'industry') {
    return senderInfo.industry || '';
  }
  if (role === 'companyType') {
    return senderInfo.companyType || '';
  }

  if (role === 'message') {
    return message || senderInfo.message || '';
  }

  if (role === 'agreed') {
    // 同意系はラベルが「同意」「確認済み」などになることが多いので、そのまま照合用文字列を返す
    return senderInfo.agreed || '同意';
  }

  // "other" や未知の role は空文字
  return '';
}



async function fillCheckbox(page, selectors, meta, filledSummary) {
  const desired = (meta.desiredLabel || '').trim();
  const combinedSelector = selectors.join(',');

  for (const frame of allFrames(page)) {
    try {
      let checkboxLocator = null;

      // --- ✨ 同意ボタン専用ロジック（最優先） --------------------------
      if (meta.role === 'agreed') {
        try {
          const consentTarget = await frame.evaluate(() => {
            const inputs = Array.from(
              document.querySelectorAll('input[type="checkbox"], input[type="radio"]')
            );
            const norm = (s) => (s || '').trim().toLowerCase();
            const hasConsent = (s) =>
              ['同意', '確認', '了承', '送信内容', 'プライバシ', 'privacy', '個人情報', '規約', 'terms', 'agree', 'consent'].some(
                (kw) => norm(s).includes(norm(kw))
              );
            const getLabelText = (input) => {
              const id = input.id;
              if (id) {
                const lbl = document.querySelector(`label[for="${id}"]`);
                if (lbl && lbl.textContent) return lbl.textContent.trim();
              }
              const parentLabel = input.closest('label');
              if (parentLabel && parentLabel.textContent) return parentLabel.textContent.trim();
              const parent = input.parentElement;
              if (parent && parent.textContent) return parent.textContent.trim();
              return '';
            };

            for (let i = 0; i < inputs.length; i += 1) {
              const label = getLabelText(inputs[i]);
              const value = inputs[i].value || '';
              if (hasConsent(label) || hasConsent(value)) {
                return { index: i, label: label || value || 'consent' };
              }
            }
            return null;
          });

          if (consentTarget) {
            const handles = await frame.$$(
              'input[type="checkbox"], input[type="radio"]'
            );
            const handle = handles[consentTarget.index];
            if (handle) {
              await handle.check({ force: true });
              const choiceLabel = consentTarget.label || 'consent';
              console.log(
                `☑️ 同意チェックを付けました (frame: ${frame.url()}) choice="${choiceLabel}"`
              );
              pushFilledSummary(filledSummary, meta, {
                selector: 'input[type="checkbox"], input[type="radio"]',
                value: choiceLabel,
              });
              return true;
            }
          }
        } catch (e) {
          console.warn('同意チェック処理でエラー:', e.message);
        }
        // 見つからなければ通常ロジックへフォールバック
      }
    

      // ① desiredLabel があるなら、まずラベルで探す
      if (desired) {
        // <label for="..."> や aria-label を使って検索
        checkboxLocator = frame
          .getByLabel(desired, { exact: false })
          .locator('input[type="checkbox"]');

        // 見つからなければ、テキストに desiredLabel を含む要素から探す
        if (!(await checkboxLocator.count())) {
          checkboxLocator = frame
            .locator(combinedSelector)
            .filter({ hasText: desired });
        }
      }

      // ② まだ見つからない場合は、最初の有効なチェックボックスを使う
      if (!checkboxLocator || !(await checkboxLocator.count())) {
        checkboxLocator = frame
          .locator(combinedSelector)
          .filter({ hasNot: frame.locator(':disabled') });
      }

      // それでも無ければ次の frame へ
      if (!(await checkboxLocator.count())) {
        continue;
      }

      const handle = checkboxLocator.first();
      await handle.check({ force: true });

      // ラベル or value などから表示用の文字列を取る
      const choiceLabel = await handle.evaluate((el) => {
        const getLabelText = (input) => {
          const id = input.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${id}"]`);
            if (lbl && lbl.textContent) return lbl.textContent.trim();
          }
          const parentLabel = input.closest('label');
          if (parentLabel && parentLabel.textContent) {
            return parentLabel.textContent.trim();
          }
          const parent = input.parentElement;
          if (parent && parent.textContent) {
            return parent.textContent.trim();
          }
          return '';
        };

        const label =
          getLabelText(el) ||
          el.getAttribute('aria-label') ||
          el.value ||
          el.id ||
          el.name ||
          'checked';

        return label;
      });

      console.log(
        `☑️ Checked checkbox for role="${meta.role}" (choice="${choiceLabel}") (frame: ${frame.url()})`
      );

      pushFilledSummary(filledSummary, meta, {
        selector: combinedSelector,
        value: choiceLabel,
      });

      return true;
    } catch (_e) {
      // 次の frame へ
    }
  }

  // どの frame でもチェックできなかった場合
  console.warn(
    `⚠️ チェックボックスをクリックできませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );

  const otherMeta = {
    ...meta,
    originalRole: meta.role,
    role: 'other',
    roles: ['other'],
  };

  pushFilledSummary(filledSummary, otherMeta, {
    selector: '',
    value: '',
  });

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

            const matchConsent = (o) => {
              const l = norm(o.label);
              const v = norm(o.value);
              return (
                l.includes('同意') ||
                l.includes('確認') ||
                l.includes('了承') ||
                l.includes('送信内容') ||
                l.includes('プライバシ') ||
                l.includes('privacy') ||
                l.includes('個人情報') ||
                l.includes('規約') ||
                l.includes('terms') ||
                v.includes('agree') ||
                v.includes('consent') ||
                v.includes('同意')
              );
            };

            const consentHit = options.find((o) => matchConsent(o));
            if (consentHit) return consentHit;

            return null;
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

  // ★入力せず、otherで記録する
  const otherMeta = {
    ...meta,
    originalRole: meta.role,
    role: 'other',
    roles: ['other'],
  };
  pushFilledSummary(filledSummary, otherMeta, {
    selector: 'other',
    value: meta.label || '',
  });
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
      } catch (_e) {
        // この selector / frame はあきらめて次へ
      }
    }
  }

  console.warn(
    `⚠️ select に値を設定できませんでした role="${meta.role}" name="${meta.nameAttr}" id="${meta.idAttr}"`
  );
  const otherMeta = {
    ...meta,
    originalRole: meta.role,
    role: 'other',
    roles: ['other'],
  };

  pushFilledSummary(filledSummary, otherMeta, {
    selector: '',
    value: '',
  });
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
  await disableFormLinks(page);

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

    // すべての roles についての値一覧（ログ用 & 結合用）
    const multiValue = [];
    for (const r of roles) {
      const raw = valueForRole(r, senderInfo, message);
      if (raw == null || raw === '') continue;
      multiValue.push({ role: r, value: String(raw) });
    }

    // 実際にフィールドへ入れる value を決定
    let value = preferredOption || '';
    if (!value && multiValue.length) {
      value = multiValue[0].value; // 最初のロールの値
    }

    // text / textarea の場合、roles が複数あれば連結文字列に
    if (
      !preferredOption &&
      multiValue.length > 1 &&
      type !== 'select' &&
      type !== 'radio' &&
      type !== 'checkbox'
    ) {
      value = multiValue.map((m) => m.value).join(' ・ ');
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

    // role=other は入力を行わずサマリだけ残す
    if (role === 'other') {
      pushFilledSummary(filledSummary, meta, { selector: 'other', value: '' });
      continue;
    }

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
