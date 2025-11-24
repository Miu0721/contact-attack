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

/** ①-1 ルールベースで問い合わせページ候補を集める */
async function collectRuleBasedContactUrls(page, companyTopUrl) {
  const hits = [];

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
          hits.push(url);
        }
      }
    } catch (e) {
      console.warn('Rule-based URL error:', url, e.message);
    }
  }

  return hits;
}

/** ①-2 AI に "問い合わせっぽいリンク" を選ばせる（複数indexを返してもOK） */
async function tryAIContactUrl(page, companyTopUrl, userPrompt) {
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
  console.log('🔗 AI に渡すリンク数:', linksForAI.length);
  console.log('🔗 サンプルリンク:', linksForAI.slice(0, 5));

  const defaultPrompt = `
You are an assistant that selects the most likely "contact / inquiry / お問い合わせ / support / request" link from a list.
- Prefer general contact/inquiry/support/request/contact-form links.
- Never pick recruit/career/job links.
- Do not pick privacy/policy/terms links.
- Do not pick news/blog/press/IR links.
- Do not pick SNS links (Twitter/X/Facebook/Instagram/LINE, etc).
  `.trim();

  const headPrompt =
    userPrompt && userPrompt.trim() ? userPrompt.trim() : defaultPrompt;

  const prompt = `
${headPrompt}

Base URL: ${companyTopUrl}

Here is a list of links (index, href, text):
${JSON.stringify(linksForAI, null, 2)}

Return ONLY this JSON (no extra text):
{ "indexes": [<numbers>]} // up to 3 most likely indexes in descending likelihood

If none look like a contact page, return:
{ "indexes": [] }
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-5-mini',
    input: prompt,
    max_output_tokens: 20000,
  });
  console.log('📨 OpenAI response raw:', JSON.stringify(response, null, 2));


  // AIからの生テキスト抽出
  let raw = '';

  try {
    if (typeof response.output_text === 'string') {
      raw = response.output_text;
    } else if (Array.isArray(response.output) && response.output.length > 0) {
      const first = response.output[0];

      if (Array.isArray(first.content) && first.content.length > 0) {
        const c = first.content[0];

        if (typeof c.text === 'string') {
          raw = c.text;
        } else if (c.text && typeof c.text.value === 'string') {
          raw = c.text.value;
        } else if (typeof c === 'string') {
          raw = c;
        }
      }
    }
  } catch (e) {
    console.warn('AI レスポンス抽出失敗:', e);
  }

  raw = (raw || '').trim();
  console.log('🧠 Contact-link AI raw response:', raw);

  if (!raw) return [];

  // { ... } の部分だけ抜き出す
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('AI JSON parse失敗:', jsonStr, e.message);
    return [];
  }

  // indexes (配列) or index (単一) を許容
  const indexes = Array.isArray(parsed.indexes)
    ? parsed.indexes
    : typeof parsed.index === 'number'
      ? [parsed.index]
      : [];

  const validIdx = indexes
    .filter((i) => Number.isInteger(i) && i >= 0 && i < linksForAI.length);

  if (!validIdx.length) return [];

  const urls = [];
  for (const i of validIdx) {
    const chosen = linksForAI[i];
    try {
      const abs = new URL(chosen.href, companyTopUrl).toString();
      urls.push(abs);
    } catch (e) {
      console.warn('選ばれた href を URL に変換できませんでした:', chosen.href, e.message);
    }
  }

  console.log('✅ AIが返した候補URL:', urls);
  return urls;
}

/** すべての候補URLを返す（ルールベース + AI） */
export async function findContactPageCandidates(page, companyTopUrl, userPrompt) {
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });
  console.log('🏁 企業TOPへアクセス:', companyTopUrl);

  const candidates = [];

  // ルールベース探索は現在無効化（AI のみ使用）
  const ruleHits = [];

  // AI 判定は最新のTOPで実行
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });
  const aiHits = await tryAIContactUrl(page, companyTopUrl, userPrompt);
  candidates.push(...aiHits);

  // 重複除去
  const seen = new Set();
  const unique = [];
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }

  return unique;
}

/** 既存互換：最初の候補だけ返す */
export async function findContactPageUrl(page, companyTopUrl, userPrompt) {
  const list = await findContactPageCandidates(page, companyTopUrl, userPrompt);
  return list[0] || null;
}
