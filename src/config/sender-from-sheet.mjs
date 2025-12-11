// src/config/sender-from-sheet.mjs
import { createRequire } from 'module';
const { google } = createRequire(import.meta.url)('googleapis'); // googleapis は CJS のため require を使用
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う（1枚のシート運用に統一）
const SPREADSHEET_ID = process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';

// 詳細ログ用タブ名（1送信=1行で質問/回答を残したい場合）

let sheetsClient = null;
let contactRoleHeadersCache = null;

/**
 * ラジオボタン・チェックボックスの論理フィールドを統合する
 * - 同じ type(=radio/checkbox) + name/id のものは 1つにまとめる
 */
function collapseLogicalFields(entries = []) {
  const seen = new Set();
  const result = [];

  for (const item of entries) {
    const isGroupTarget =
      item.type === 'radio' || item.type === 'checkbox';

    if (isGroupTarget) {
      const hasAttr = item.nameAttr || item.idAttr;
      const groupKey = hasAttr
        ? item.nameAttr || item.idAttr
        : 'NO_ATTR_GROUP'; // name/id が無い連続チェックボックスは1つにまとめる
      const key = `${item.type}|${groupKey}`;

      if (seen.has(key)) continue;
      seen.add(key);
    }

    result.push(item);
  }

  return result;
}

/**
 * Google Sheets クライアントを作成（Contacts と同じ認証方式）
 */
async function getSheets() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    // ★ contactsRepo.mjs と同じ
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Contacts シートの J1 以降から role 名のヘッダーを取得
 * 例: ['name', 'lastName', 'firstName', ...]
 */
async function getContactRoleHeaders() {
  if (contactRoleHeadersCache) return contactRoleHeadersCache;
  if (!SPREADSHEET_ID) return [];

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    // K列以降は role 用のヘッダー。右方向に増えても拾えるよう広めに取得する。
    // NOTE: スプシのContactsに項目増やしたら、ここを対応！
    range: `Contacts!K1:AX1`,
  });

  const row = (res.data.values && res.data.values[0]) || [];
  const headers = row.map((v) => String(v).trim()).filter(Boolean);

  contactRoleHeadersCache = headers;
  return headers;
}


/**
 * Sender シートから自社情報を取得して、
 * { senderInfo } を返す
 */
export async function loadSenderFromSheet() {
  if (!SPREADSHEET_ID) {
    console.warn(
      'SHEET_ID が設定されていないので、Sender シート読み込みをスキップします'
    );
    return null;
  }

  const sheets = await getSheets();

  /* 
  NOTE: スプシのsender情報を変更したら、ここを対応！
  */ 
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    // NOTE: スプシのsender情報を変更したら、ここを対応！
    range: `${SENDER_SHEET_NAME}!A2:B100`,
  });

  const rows = res.data.values || [];
  if (!rows.length) {
    console.warn('Sender シートに値がありません');
    return null;
  }

  const map = {};
  for (const row of rows) {
    const [key, value] = row;
    if (!key) continue;
    map[String(key).trim()] = value || '';
  }

  // NOTE: スプシのsender情報を変更したら、ここを対応！{A列の値： map.A列の値}
  const senderInfo = {
    name: map.name,
    lastName: map.lastName,
    firstName: map.firstName,
    nameKana: map.nameKana,
    lastNameKana: map.lastNameKana,
    firstNameKana: map.firstNameKana,
    nameHira: map.nameHira,
    firstNameHira: map.firstNameHira,
    lastNameHira: map.lastNameHira,
    email: map.email,
    comfirmEmail: map.comfirmEmail,
    companyName: map.companyName,
    companyNameKana: map.companyNameKana,
    department: map.department,
    phone1: map.phone1,
    phone2: map.phone2,
    phone3: map.phone3,
    corporateSiteUrl: map.corporateSiteUrl,
    position: map.position,
    referral: map.referral,
    gender: map.gender,
    country: map.country,
    postalCode1: map.postalCode1,
    postalCode2: map.postalCode2,
    prefecture: map.prefecture,
    city: map.city,
    town: map.town,
    street: map.street,
    building: map.building,
    age: map.age,
    subject: map.subject,
    inquiryType: map.inquiryType, 
    industry: map.industry,
    message: map.message,
  };

  return { senderInfo };
}

/**
 * Contacts シートの K列以降に、
 * role ごとの入力値を1行分書き込む
 *
 * @param {Object} contact - Contacts シート1行分のオブジェクト（rowIndex 必須）
 * @param {Array} filledSummary - fillContactForm が返した入力サマリ
 */
export async function updateContactFormFieldLog(contact, filledSummary = []) {
  if (!SPREADSHEET_ID) {
    console.warn(
      'SHEET_ID が未設定のため、Contacts へのフォームログ出力をスキップします'
    );
    return;
  }
  if (!contact || !contact.rowIndex) {
    console.warn(
      'updateContactFormFieldLog: contact.rowIndex がありません'
    );
    return;
  }

  const headers = await getContactRoleHeaders();
  if (!headers.length) {
    console.warn(
      'updateContactFormFieldLog: Contacts シートの K1 以降にヘッダーがありません'
    );
    return;
  }

  // role → value のマップを作成
  // filledSummary の 1 件に roles が複数あれば、その value を該当する role すべてに入れる
  const valueByRole = {};

  for (const item of filledSummary || []) {
    if (!item) continue;

    // item.roles があればそれを優先、なければ item.role 単体
    const roles = Array.isArray(item.roles) && item.roles.length
      ? item.roles
      : item.role
      ? [item.role]
      : [];

    if (!roles.length) continue;

    // スプレッドシートに書き込む値（required フラグ付き）
    if (item.value == null) continue;
    let val = String(item.value);
    if (item.required) {
      val = `required${val}`;
    }

    // 当てはまる role すべてに同じ値を書き込む
    for (const r of roles) {
      const roleName = String(r).trim();
      if (!roleName) continue;

      // すでに値が入っている role は上書きしない（最初に埋めたものを優先）
      if (valueByRole[roleName] == null) {
        valueByRole[roleName] = val;
      }
    }
  }

  // ヘッダー順に値を並べる。存在しない role は ''（空）にする
  const rowValues = headers.map((roleName) => valueByRole[roleName] || '');

  const sheets = await getSheets();
  const rowIndex = contact.rowIndex;

  // Contacts!K{rowIndex} から右方向に rowValues を書き込む
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Contacts!K${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [rowValues],
    },
  });
}


/**
 * Contacts シートに結果を出力。
 * @param {Object} params
 * @param {Object} params.contact - Contactsシート1行分のオブジェクト（任意）
 * @param {Array} params.filledSummary - fillContactForm が返した入力サマリ
 * @param {Object} params.formSchema - analyzeContactFormWithAI の返り値
 */
export async function appendFormQuestionsAndAnswers(params = {}) {
  if (!SPREADSHEET_ID) {
    console.warn(
      'SHEET_ID が未設定のため、フォームログ出力はスキップします'
    );
    return;
  }

  const {
    contact,
    filledSummary,
    formSchema,
  } = params;

  // --- ① スキーマ(formSchema)とfilledSummaryをマージして「最終的な項目リスト」を作る ---

  const mergeEntries = () => {
    const schemaFields =
      (formSchema?.fields || []).map((f, idx) => ({
        ...f,
        value: '',
        order: idx + 1,
      })) || [];

    const summary = filledSummary || [];

    const keyOf = (item) =>
      [
        item.role || 'field',
        item.nameAttr || '',
        item.idAttr || '',
        item.label || '',
      ].join('|');

    const map = new Map();

    schemaFields.forEach((item) => {
      map.set(keyOf(item), { ...item });
    });

    summary.forEach((item) => {
      const k = keyOf(item);
      if (map.has(k)) {
        map.set(k, { ...map.get(k), ...item });
      } else {
        map.set(k, { ...item });
      }
    });

    return Array.from(map.values());
  };

  const entries = mergeEntries();
  const normalizedEntries = collapseLogicalFields(entries);

  if (!normalizedEntries.length) {
    console.warn('appendFormQuestionsAndAnswers: ログ対象の項目がありません');
    return;
  }

  // --- role === 'other' のラベルを集める（Contacts!J列用） ---
  const otherLabels = normalizedEntries
    .filter((item) => item && (item.role || 'field') === 'other')
    .map((item, idx) => {
      const label =
        item.label ||
        item.nameAttr ||
        item.idAttr ||
        `field${idx + 1}`;
      // 必須なら required を付けたい場合
      return item.required ? `required${label}` : label;
    })
    .filter((s) => s !== '');


  try {
    const sheets = await getSheets();


    // --- Contacts の J列 & K列以降にだけ値を反映 ---
    if (contact && contact.rowIndex) {
      const rowIndex = contact.rowIndex;

      // other ラベル一覧を J列に書き込む（複数なら / でくっつける）
      if (otherLabels.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Contacts!J${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[otherLabels.join(' / ')]], // ← ここでくっつけて1セルに
          },
        });
      }

      // 既存処理: role ごとの値を K列以降へ
      await updateContactFormFieldLog(contact, normalizedEntries);
    }
  } catch (err) {
    console.warn(
      `appendFormQuestionsAndAnswers: Contacts シートへの書き込みに失敗`,
      err.message || err
    );
  }
}
