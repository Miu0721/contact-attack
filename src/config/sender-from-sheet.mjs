// src/config/sender-from-sheet.mjs
import { createRequire } from 'module';
const { google } = createRequire(import.meta.url)('googleapis'); // googleapis は CJS のため require を使用
import 'dotenv/config';

// Contacts と同じスプレッドシートIDを使う（1枚のシート運用に統一）
const SPREADSHEET_ID = process.env.SHEET_ID;

// Sender 用のタブ名（シート名）
const SENDER_SHEET_NAME = 'Sender';

// 詳細ログ用タブ名（1送信=1行で質問/回答を残したい場合）
// 別タブにしたくなければ .env の FORM_LOG_SHEET_NAME を Contacts にしてもOK
const FORM_LOG_SHEET_NAME =
  process.env.FORM_LOG_SHEET_NAME || 'FormLogs';

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
    // L列以降は role 用のヘッダー。右方向に増えても拾えるよう広めに取得する。
    range: `Contacts!L1:AT1`,
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

      // ★必要ならここで FormLogs のヘッダーを書く（任意）
      // await sheets.spreadsheets.values.update({
      //   spreadsheetId: SPREADSHEET_ID,
      //   range: `${FORM_LOG_SHEET_NAME}!A1:E1`,
      //   valueInputOption: 'USER_ENTERED',
      //   requestBody: { values: [['timestamp','companyName','rowIndex','siteUrl','contactUrl']] },
      // });
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
    industry: map.industry,
    companyType: map.companyType,
    subject: map.subject,
    prefecture: map.prefecture,
    address: map.address,
    age: map.age,
    email: map.email,
    company: map.company,
    department: map.department,
    postalCode1: map.postalCode1,
    postalCode2: map.postalCode2,
    phone1: map.phone1,
    phone2: map.phone2,
    phone3: map.phone3,
    prefecture: map.prefecture,
    city: map.city,
    town: map.town,
    street: map.street,
    building: map.building,
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
      'updateContactFormFieldLog: Contacts シートの L1 以降にヘッダーがありません'
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


/**
 * フォームの質問項目と入力値を FormLogs シートに 1行 追記する
 * ついでに、Contacts シートの L列以降に role ごとの値も反映する。
 *
 * @param {Object} params
 * @param {Object} params.contact - Contactsシート1行分のオブジェクト（任意）
 * @param {string} params.contactUrl - 実際にアクセスした問い合わせURL
 * @param {string} params.siteUrl - 企業サイトのURL
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
    contactUrl,
    siteUrl,
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

  // ★ 追加: role === 'other' のラベルを集める（Contacts!K列用）
  const otherLabels = [];
  normalizedEntries.forEach((item, idx) => {
    const role = item.role || 'field';
    if (role === 'other') {
      const label =
        item.label ||
        item.nameAttr ||
        item.idAttr ||
        `field${idx + 1}`;
      otherLabels.push(label);
    }
  });

  const timestamp = new Date().toISOString();

  // --- ② FormLogs 用の1行ぶんデータを組み立てる ---

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
    const rawVal = item.value != null ? String(item.value) : '';
    const val = item.required ? `required${rawVal}` : rawVal;
    answerCols.push(key, val); // 質問 → 回答 のペア
  });

  const row = [...baseCols, ...answerCols];

  try {
    const sheets = await getSheets();

    await ensureFormLogSheetExists();

    // A列の最終行+1 を探して、そこに1行書き込む
    const existing = await sheets.spreadsheets.values
      .get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${FORM_LOG_SHEET_NAME}!A:A`,
      })
      .catch(() => ({ data: { values: [] } }));

    const startRow =
      (existing.data.values && existing.data.values.length) || 0;
    const startIndex = startRow + 1; // 1-based

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${FORM_LOG_SHEET_NAME}!A${startIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });

    // Contacts の K列 & L列以降にも値を反映
    if (contact && contact.rowIndex) {
      const rowIndex = contact.rowIndex;

      // ★ 追加: Contacts の K列に "other" のラベル一覧を出力（改行区切り）
      if (otherLabels.length > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Contacts!K${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[otherLabels.join('\n')]], // カンマ区切りにしたければ ', ' に変える
          },
        });
      }

      // 既存処理: role ごとの値を L列以降へ
      await updateContactFormFieldLog(contact, normalizedEntries);
    }
  } catch (err) {
    console.warn(
      `appendFormQuestionsAndAnswers: ログシート/Contacts シートへの書き込みに失敗`,
      err.message || err
    );
  }
}
