// src/lib/google/contactsRepo.mjs
import { google } from 'googleapis';
import 'dotenv/config';

// ---- 設定ここだけ意識すればOK ----------------------------------

// .env に SHEET_ID=xxxxxxxxxxxxxxxx を入れておくこと
const SPREADSHEET_ID = process.env.SHEET_ID;
// シート名（タブ名）。あなたが作ったシート名に合わせてね
const CONTACTS_SHEET_NAME = 'Contacts';

// -----------------------------------------------------------------

let sheetsClient = null;
let cachedContactsSheetId = null;

/**
 * Google Sheets クライアントを作成（初回だけ）
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
 * Contacts シートの sheetId を取得（背景色変更に必要）
 */
async function getContactsSheetId() {
  if (cachedContactsSheetId !== null) return cachedContactsSheetId;

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const sheet = res.data.sheets.find(
    (s) => s.properties.title === CONTACTS_SHEET_NAME
  );

  if (!sheet) {
    throw new Error(
      `Sheet "${CONTACTS_SHEET_NAME}" not found in this spreadsheet`
    );
  }

  cachedContactsSheetId = sheet.properties.sheetId;
  return cachedContactsSheetId;
}

/**
 * Contacts シートから全行を取得して、
 * 1行 = 1企業 のオブジェクト配列として返す
 */
export async function fetchContacts() {
  const sheets = await getSheets();

  const range = `${CONTACTS_SHEET_NAME}!A2:I`; // 1行目はヘッダ想定
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = res.data.values || [];

  // rows[0] = 2行目 → rowIndex = 2
  return rows.map((row, idx) => {
    const rowIndex = idx + 2;

    const [
      id,
      companyName,
      siteUrl,
      contactUrl,
      status,
      lastRunAt,
      lastResult,
      lastErrorMsg,
      runCount,
    ] = row;

    return {
      rowIndex,
      id: id ?? '',
      companyName: companyName ?? '',
      siteUrl: siteUrl ?? '',
      contactUrl: contactUrl ?? '',
      status: status ?? '',
      lastRunAt: lastRunAt ?? '',
      lastResult: lastResult ?? '',
      lastErrorMsg: lastErrorMsg ?? '',
      runCount: runCount ? Number(runCount) : 0,
    };
  });
}

/**
 * 既存の contact オブジェクトに patch をマージして、
 * A〜I列の1行まるごとを更新する
 *
 * contact: fetchContacts() で取ってきた1行分
 * patch:   上書きしたいフィールドだけ指定してOK
 */
export async function updateContactRowValues(contact, patch) {
  const sheets = await getSheets();

  const merged = {
    ...contact,
    ...patch,
  };

  const rowIndex = merged.rowIndex;

  const values = [
    [
      merged.id ?? '',
      merged.companyName ?? '',
      merged.siteUrl ?? '',
      merged.contactUrl ?? '',
      merged.status ?? '',
      merged.lastRunAt ?? '',
      merged.lastResult ?? '',
      merged.lastErrorMsg ?? '',
      merged.runCount ?? '',
    ],
  ];

  const range = `${CONTACTS_SHEET_NAME}!A${rowIndex}:I${rowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  });
}

/**
 * Status に応じて、行全体の背景色を変更する
 */
export async function updateContactRowColor(rowIndex, status) {
  const sheets = await getSheets();
  const sheetId = await getContactsSheetId();

  // Status に応じて色を決める（0〜1のRGB）
  let color = { r: 1, g: 1, b: 1 }; // デフォルト白

  switch (status) {
    case 'Success':
      color = { r: 0.85, g: 0.97, b: 0.85 }; // 淡い緑
      break;
    case 'Failed':
      color = { r: 0.97, g: 0.85, b: 0.85 }; // 淡い赤
      break;
    case 'Skipped':
      color = { r: 0.9, g: 0.9, b: 0.9 }; // グレー
      break;
    case 'Pending':
    default:
      color = { r: 1, g: 1, b: 1 }; // 白
      break;
  }

  // rowIndex は 1始まりだが、batchUpdate の index は 0始まり
  const startRowIndex = rowIndex - 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex,
              endRowIndex: startRowIndex + 1,
              startColumnIndex: 0, // A列
              endColumnIndex: 9, // I列 (0〜8)
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: color,
              },
            },
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
      ],
    },
  });
}
