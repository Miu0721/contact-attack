// src/url-discovery.mjs
import { openai } from './lib/openai.mjs';

/** ルールベースで試すパス一覧 */
const RULE_BASED_PATHS = [
  // contact系
  '/contact',
  '/contact/',
  '/contact.html',
  '/contact/index.html',

  '/contact-us',
  '/contact-us/',
  '/contact-us.html',
  '/contact-us/index.html',

  // inquiry系
  '/inquiry',
  '/inquiry/',
  '/inquiry.html',
  '/inquiry/index.html',

  // support系
  '/support',
  '/support/',
  '/support.html',
  '/support/index.html',

  // 日本語
  '/お問い合わせ',
  '/お問い合わせ/',
  '/お問い合わせ.html',
  '/お問い合わせ/index.html',

  // よくある追加パターン
  '/contact-form',
  '/contact-form/',
  '/form/contact',
  '/company/contact',
];

/** ベースURLと相対パスを合成 */
function buildUrl(baseUrl, path) {
  const u = new URL(baseUrl);
  if (path.startsWith('/')) return `${u.origin}${path}`;
  return `${u.origin}/${path}`;
}

/** ①-1 ルールベースで問い合わせページを探す */
async function tryRuleBasedContactUrl(page, companyTopUrl) {
  for (const path of RULE_BASED_PATHS) {
    const url = buildUrl(companyTopUrl, path);
    console.log('🔎 Rule-based checking:', url);

    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = res?.status() ?? 0;

      // 2xx or 3xx は有効
      if (status >= 200 && status < 400) {
        // form or input があるか軽く判定
        const hasForm = await page.$('form, input, textarea, select');

        if (hasForm) {
          console.log('✅ Rule-based contact page found:', url);
          return url;
        }
      }
    } catch (e) {
      console.warn('Rule-based URL error:', url, e.message);
    }
  }

  return null;
}

/** ①-2 AI に "問い合わせっぽいリンク" を選ばせる */
async function tryAIContactUrl(page, companyTopUrl) {
  console.log('🤖 tryAIContactUrl START', { url: page.url(), companyTopUrl });

  const currentUrl = page.url() || companyTopUrl;
  let origin;
  try {
    origin = new URL(currentUrl).origin;
  } catch {
    try {
      origin = new URL(companyTopUrl).origin;
    } catch {
      origin = null;
    }
    console.log('🔗 AI に渡すリンク数:', linksForAI.length);
    console.log('🔗 サンプルリンク:', linksForAI.slice(0, 5));

  }

  // ページ内の a タグ（リンク）を全部収集
  const rawLinks = await page.$$eval('a', (as) =>
    as.map((a) => ({
      href: a.getAttribute('href') || '',
      text: (a.innerText || a.textContent || '').trim(),
    })),
  );

  // フィルタリング:
  // - href が存在するものだけ
  // - mailto:, tel:, javascript: は除外
  // - 外部ドメインは基本除外（origin が取れないときはスキップ）
  const links = rawLinks
    .filter((l) => !!l.href)
    .filter((l) => {
      const href = l.href.trim();
      if (!href || href === '#' || href.startsWith('#')) return false;
      if (href.startsWith('mailto:')) return false;
      if (href.startsWith('tel:')) return false;
      if (href.toLowerCase().startsWith('javascript:')) return false;

      if (!origin) return true;

      try {
        const u = new URL(href, origin);
        // 外部ドメインは除外
        return u.origin === origin;
      } catch {
        return false;
      }
    });

  if (!links.length) {
    console.warn('リンクが1件も見つかりませんでした');
    return null;
  }

  console.log('🔗 AI判定用リンク候補数(フィルタ後):', links.length);

  // 多すぎるとAIが大変なので50件まで
  const linksForAI = links.slice(0, 50);

  // AI用プロンプト（NGワードも明示）
  const prompt = `
あなたは「問い合わせページのリンク」を選ぶ分類器です。
以下のJSON配列（リンク一覧）から、
B2B 企業向けの「問い合わせ / Contact / お問い合わせ / Inquiry / Support / 資料請求」などに該当しそうなリンクを1つ選んでください。

選び方のルール:
- 一般的な問い合わせフォーム/コンタクトフォームを最優先で選ぶ
- 採用/キャリア/求人 (例: "採用", "recruit", "career", "jobs") は絶対に選ばない
- プライバシーポリシー/利用規約/個人情報保護 (例: "privacy", "policy", "terms", "利用規約", "プライバシー") は選ばない
- お知らせ/ニュース/ブログ/IR (例: "news", "お知らせ", "ブログ", "press", "ir") は選ばない
- SNS (例: "twitter", "x.com", "facebook", "instagram", "line") は選ばない

返す形式は必ず **次のJSONだけ**：
{ "index": 数値 }

- index は 0 〜 配列の長さ-1 の範囲の整数
- もし適切な問い合わせリンクが本当に無い場合は { "index": -1 } を返してください

リンク一覧（index は配列のインデックスです）:
${JSON.stringify(linksForAI, null, 2)}
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    input: prompt,
    max_output_tokens: 100,
  });
  console.log('📨 OpenAI response raw:', JSON.stringify(response, null, 2));


  // AIからの生テキスト抽出
  // --- ここからレスポンス抽出ロジックを書き換え ---
  let raw = '';

  try {
    // 1. output_text があればそれを優先（ラッパーで用意している場合）
    if (typeof response.output_text === 'string') {
      raw = response.output_text;
    } else if (Array.isArray(response.output) && response.output.length > 0) {
      const first = response.output[0];

      if (Array.isArray(first.content) && first.content.length > 0) {
        const c = first.content[0];

        // パターン1: { text: "..." }
        if (typeof c.text === 'string') {
          raw = c.text;
        }
        // パターン2: { text: { value: "..." } }
        else if (c.text && typeof c.text.value === 'string') {
          raw = c.text.value;
        }
        // 念のため fallback
        else if (typeof c === 'string') {
          raw = c;
        }
      }
    }
  } catch (e) {
    console.warn('AI レスポンス抽出失敗:', e);
  }

  raw = (raw || '').trim();
  console.log('🧠 Contact-link AI raw response:', raw);

  if (!raw) return null;


  if (!raw) return null;

  // { ... } の部分だけ抜き出す
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('AI JSON parse失敗:', jsonStr, e.message);
    return null;
  }

  if (typeof parsed.index !== 'number') return null;
  if (parsed.index === -1) return null;
  if (parsed.index < 0 || parsed.index >= linksForAI.length) return null;

  const chosen = linksForAI[parsed.index];
  console.log('✅ AIが選んだリンク:', chosen);

  // 相対パスに対応
  try {
    return new URL(chosen.href, companyTopUrl).toString();
  } catch (e) {
    console.warn('選ばれた href を URL に変換できませんでした:', chosen.href, e.message);
    return null;
  }
}

/** ① メイン：問い合わせページURLを返す */
export async function findContactPageUrl(page, companyTopUrl) {
  // TOP ページへ
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });
  console.log('🏁 企業TOPへアクセス:', companyTopUrl);

  // ①-1 ルールベース
  const ruleUrl = await tryRuleBasedContactUrl(page, companyTopUrl);
  if (ruleUrl) return ruleUrl;

  // ①-2 AI 判定（TOPをもう一度開いておく）
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });

  const aiUrl = await tryAIContactUrl(page, companyTopUrl);
  if (!aiUrl) {
    console.log('⚠️ AIでも問い合わせページを特定できなかったため null を返します');
    return null;
  }

  return aiUrl;
}
