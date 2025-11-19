// src/config/sender-from-sheet.mjs
import { google } from 'googleapis';
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う。
// もし Sender 用に別シートを使いたい場合は SENDER_SHEET_ID を .env に追加。
const SPREADSHEET_ID =
  process.env.SENDER_SHEET_ID || process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';

let sheetsClient = null;

/**
 * Google Sheets クライアントを作成（Contacts と同じ認証方式）
 */
async function getSheets() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    // ★ contactsRepo.mjs と同じ
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Sender シートから自社情報を取得して、
 * { senderInfo, fixedMessage, companyTopUrl } を返す
 */
export async function loadSenderFromSheet() {
  if (!SPREADSHEET_ID) {
    console.warn(
      'SENDER_SHEET_ID / SHEET_ID が設定されていないので、Sender シート読み込みをスキップします'
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
    name: map.sender_name || '',
    nameKana: map.sender_name_kana || '',
    email: map.sender_email || '',
    company: map.sender_company || '',
    department: map.sender_department || '',
    phone: map.sender_phone || '',
  };

  const fixedMessage = map.fixed_message || '';
  const companyTopUrl = map.default_company_top_url || '';

  return {
    senderInfo,
    fixedMessage,
    companyTopUrl,
  };
}
