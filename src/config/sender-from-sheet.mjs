// src/config/sender-from-sheet.mjs
import { createRequire } from 'module';
const { google } = createRequire(import.meta.url)('googleapis'); // googleapis は CJS のため require を使用
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う（1枚のシート運用に統一）
const SPREADSHEET_ID = process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';

// フォーム項目詳細ログ用タブ名（デフォルト Contacts に書く想定）
const FORM_LOG_SHEET_NAME =
  process.env.FORM_LOG_SHEET_NAME || 'Contacts';

let sheetsClient = null;
let formLogSheetChecked = false;
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
 * Contacts シートの L1:AH1 から role 名のヘッダーを取得
 * 例: ['name', 'lastName', 'firstName', ...]
 */
async function getContactRoleHeaders() {
  if (contactRoleHeadersCache) return contactRoleHeadersCache;
  if (!SPREADSHEET_ID) return [];

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Contacts!L1:AH1`,
  });

  const row = (res.data.values && res.data.values[0]) || [];
  const headers = row.map((v) => String(v).trim()).filter(Boolean);

  contactRoleHeadersCache = headers;
  return headers;
}

/**
 * FormLogs シートが存在しなければ作成する
 */
async function ensureFormLogSheetExists() {
  if (formLogSheetChecked) return;
  if (!SPREADSHEET_ID) return;

  const sheets = await getSheets();

  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });

    const exists = res.data.sheets?.some(
      (s) => s.properties?.title === FORM_LOG_SHEET_NAME
    );

    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: FORM_LOG_SHEET_NAME,
                },
              },
            },
          ],
        },
      });

      // （必要ならここでヘッダー A1:M1 を書く処理を足してもOK）
    }
  } catch (_err) {
    // ここでの失敗は append 側でリトライ・ログする
  } finally {
    formLogSheetChecked = true;
  }
}

/**
 * Sender シートから自社情報を取得して、
 * { senderInfo, message, companyTopUrl, contactPrompt } を返す
 */
export async function loadSenderFromSheet() {
  if (!SPREADSHEET_ID) {
    console.warn(
      'SHEET_ID が設定されていないので、Sender シート読み込みをスキップします'
    );
    return null;
  }

  const sheets = await getSheets();

  // Sender!A2:B100 に「key / value」形式で入っている想定
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
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

  const senderInfo = {
    name: map.name,
    nameKana: map.nameKana,
    lastName: map.lastName,
    firstName: map.firstName,
    lastNameKana: map.lastNameKana,
    firstNameKana: map.firstNameKana,
    position: map.position,
    companyPhone: map.companyPhone,
    personalPhone: map.personalPhone,
    referral: map.referral,
    gender: map.gender,
    inquiryCategory: map.inquiryCategory,
    subject: map.subject,
    postalCode: map.postalCode,
    prefecture: map.prefecture,
    address: map.address,
    age: map.age,
    email: map.email,
    company: map.company,
    department: map.department,
    phone: map.phone,
  };

  const message = map.message;
  const companyTopUrl = map.companyTopUrl;
  const contactPrompt = map.contactPrompt;

  return {
    senderInfo,
    message,
    companyTopUrl,
    contactPrompt,
  };
}

/**
 * フォームの質問項目と入力値を FormLogs シートに追記する
 *
 * @param {Object} params
 * @param {Object} params.contact - Contactsシート1行分のオブジェクト（任意）
 * @param {string} params.contactUrl - 実際にアクセスした問い合わせURL
 * @param {string} params.siteUrl - 企業サイトのURL
 * @param {Array} params.filledSummary - fillContactForm が返す入力サマリ
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
    contactUrl,
    siteUrl,
    filledSummary,
    formSchema,
  } = params;

  const entries =
    (filledSummary && filledSummary.length > 0
      ? filledSummary
      : (formSchema?.fields || []).map((f, idx) => ({
          ...f,
          value: '',
          order: idx + 1,
        }))) || [];

  const normalizedEntries = collapseLogicalFields(entries);

  if (!normalizedEntries.length) {
    console.warn('appendFormQuestionsAndAnswers: ログ対象の項目がありません');
    return;
  }

  // Contacts シートの L1:AH1 ヘッダーに沿って、対象行だけ上書きする
  const rowIndex = contact?.rowIndex;
  if (!rowIndex) {
    console.warn('appendFormQuestionsAndAnswers: rowIndex が不明のためスキップ');
    return;
  }

  try {
    const sheets = await getSheets();
    const headers = await getContactRoleHeaders();
    if (!headers.length) {
      console.warn(
        'appendFormQuestionsAndAnswers: Contacts シートの L1:AH1 にヘッダーがありません'
      );
      return;
    }

    // role→value マップ（スキーマのみ項目も含める）
    const valueByRole = {};
    for (const item of normalizedEntries) {
      const role = (item.role || '').trim();
      if (!role) continue;
      if (valueByRole[role] == null) {
        valueByRole[role] = item.value != null ? String(item.value) : '';
      }
    }

    const rowValues = headers.map((roleName) => valueByRole[roleName] || '');

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Contacts!L${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [rowValues],
      },
    });
  } catch (err) {
    console.warn(
      `appendFormQuestionsAndAnswers: Contacts シートへの書き込みに失敗`,
      err.message || err
    );
  }
}

/**
 * Contacts シートの L列以降に、
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
      'updateContactFormFieldLog: Contacts シートの L1:AH1 にヘッダーがありません'
    );
    return;
  }

  // role → value のマップを作成
  const valueByRole = {};
  for (const item of filledSummary || []) {
    if (!item || !item.role) continue;
    const role = String(item.role).trim();
    if (valueByRole[role] == null && item.value != null) {
      valueByRole[role] = String(item.value);
    }
  }

  // ヘッダー順に値を並べる。存在しない role は ''（空）にする
  const rowValues = headers.map((roleName) => valueByRole[roleName] || '');

  const sheets = await getSheets();
  const rowIndex = contact.rowIndex;

  // Contacts!L{rowIndex} から右方向に rowValues を書き込む
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Contacts!L${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [rowValues],
    },
  });
}
