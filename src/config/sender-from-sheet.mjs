// src/config/sender-from-sheet.mjs
import { createRequire } from 'module';
const { google } = createRequire(import.meta.url)('googleapis'); // googleapis は CJS のため require を使用
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う（1枚のシート運用に統一）
const SPREADSHEET_ID = process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';
const FORM_LOG_SHEET_NAME = process.env.FORM_LOG_SHEET_NAME || 'FormLogs';

let sheetsClient = null;
let formLogSheetChecked = false;

function collapseLogicalFields(entries = []) {
  const seen = new Set();
  const result = [];

  for (const item of entries) {
    const isGroupTarget = item.type === 'radio' || item.type === 'checkbox';

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
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
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
    }
  } catch (_err) {
    // ここでの失敗は append 側でリトライ・ログする
  } finally {
    formLogSheetChecked = true;
  }
}

/**
 * Sender シートから自社情報を取得
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
    organization: map.company,
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
 * 「1 URL = 1 行」横展開で記録
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

  const mergeEntries = () => {
    const schemaFields =
      (formSchema?.fields || []).map((f, idx) => ({
        ...f,
        value: '',
        order: idx + 1,
      })) || [];

    const summary = filledSummary || [];

    // キー生成: role/name/id/label でなるべく安定させる
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

  const timestamp = new Date().toISOString();

  // A〜E列: メタ情報
  const baseCols = [
    timestamp, // A
    contact?.companyName || '', // B
    contact?.rowIndex || '', // C
    siteUrl || contact?.siteUrl || '', // D
    contactUrl || contact?.contactUrl || '', // E
  ];

  // F列以降: 「質問(ラベル/role)」→「回答」の順で横展開
  const answerCols = [];
  normalizedEntries.forEach((item, idx) => {
    const label = item.label || item.nameAttr || item.idAttr || `field${idx + 1}`;
    const role = item.role || 'field';
    const key = `${role}:${label}`;
    const val = item.value != null ? String(item.value) : '';
    answerCols.push(key, val); // 質問 → 回答 のペア
  });

  const row = [...baseCols, ...answerCols];

  try {
    await ensureFormLogSheetExists();

    const sheets = await getSheets();

    // 既存の行数を取得して、最終行+1 の行に書き込む
    const existing = await sheets.spreadsheets.values
      .get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${FORM_LOG_SHEET_NAME}!A:A`,
      })
      .catch(() => ({ data: { values: [] } }));

    const startRow =
      (existing.data.values && existing.data.values.length) || 0;
    const targetRow = startRow + 1; // 1-based

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${FORM_LOG_SHEET_NAME}!A${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });
  } catch (err) {
    console.warn(
      `appendFormQuestionsAndAnswers: シート "${FORM_LOG_SHEET_NAME}" への書き込みに失敗`,
      err.message || err
    );
  }
}
