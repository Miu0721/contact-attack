// src/config/sender-from-sheet.mjs
import { createRequire } from 'module';
const { google } = createRequire(import.meta.url)('googleapis'); // googleapis は CJS のため require を使用
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う（1枚のシート運用に統一）
const SPREADSHEET_ID = process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';
const FORM_LOG_SHEET_NAME =
  process.env.FORM_LOG_SHEET_NAME || 'FormLogs';

let sheetsClient = null;
let formLogSheetChecked = false;

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
 * Sender シートから自社情報を取得して、
 * { senderInfo, message, companyTopUrl } を返す
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
    // フルネームが優先、無ければ姓+名の結合
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
      : (formSchema?.fields || []).map((f) => ({ ...f, value: '' }))) || [];

  if (!entries.length) {
    console.warn('appendFormQuestionsAndAnswers: ログ対象の項目がありません');
    return;
  }

  const timestamp = new Date().toISOString();
  const rows = entries.map((item) => [
    timestamp,
    contact?.companyName || '',
    contact?.rowIndex || '',
    siteUrl || contact?.siteUrl || '',
    contactUrl || contact?.contactUrl || '',
    item.role || '',
    item.label || '',
    item.type || '',
    item.nameAttr || '',
    item.idAttr || '',
    item.selector || '',
    item.value != null ? String(item.value) : '',
  ]);

  try {
    await ensureFormLogSheetExists();

    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${FORM_LOG_SHEET_NAME}!A:L`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows,
      },
    });
  } catch (err) {
    console.warn(
      `appendFormQuestionsAndAnswers: シート "${FORM_LOG_SHEET_NAME}" への書き込みに失敗`,
      err.message || err
    );
  }
}
