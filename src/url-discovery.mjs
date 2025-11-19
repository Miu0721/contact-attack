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
async function tryAIContactUrl(page) {
  // ページ内の a タグ（リンク）を全部収集
  const links = await page.$$eval('a', (as) =>
    as
      .map((a) => ({
        href: a.getAttribute('href') || '',
        text: (a.innerText || a.textContent || '').trim(),
      }))
      .filter((l) => l.href && l.text)
  );

  if (!links.length) {
    console.warn('リンクが1件も見つかりませんでした');
    return null;
  }

  console.log('🔗 AI判定用リンク候補数:', links.length);

  const linksForAI = links.slice(0, 50); // 多すぎるとAIが困るので50まで

  // AI用プロンプト
  const prompt = `
あなたは「問い合わせページのリンク」を選ぶ分類器です。
以下のJSON配列（リンク一覧）から、
問い合わせ / Contact / Inquiry / Support / お問い合わせ
などに該当しそうなリンクを1つ選んでください。

返す形式は必ず以下だけ：

{ "index": 数値 }

index は 0 〜 配列の長さ-1 の範囲。
該当が無ければ { "index": -1 } を返す。

リンク一覧:
${JSON.stringify(linksForAI, null, 2)}
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    input: prompt,
    max_output_tokens: 100,
  });

  // AIからの生テキスト抽出
  let raw = '';
  try {
    if (response.output_text) {
      raw = response.output_text;
    } else if (response.output?.length > 0) {
      raw = response.output[0]?.content?.[0]?.text?.value || '';
    }
  } catch (e) {
    console.warn('AI レスポンス抽出失敗:', e.message);
  }

  raw = (raw || '').trim();
  console.log('🧠 Contact-link AI raw response:', raw);

  if (!raw) return null;

  // { ... } の部分だけ抜き出す
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn('AI JSON parse失敗:', jsonStr);
    return null;
  }

  if (parsed.index === -1) return null;
  if (parsed.index < 0 || parsed.index >= linksForAI.length) return null;

  const chosen = linksForAI[parsed.index];
  console.log('✅ AIが選んだリンク:', chosen);

  return chosen.href;
}

/** ① メイン：問い合わせページURLを返す */
export async function findContactPageUrl(page, companyTopUrl) {
  // TOP ページへ
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });
  console.log('🏁 企業TOPへアクセス:', companyTopUrl);

  // ①-1 ルールベース
  const ruleUrl = await tryRuleBasedContactUrl(page, companyTopUrl);
  if (ruleUrl) return ruleUrl;

  // ①-2 AI 判定
  await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });

  const aiHref = await tryAIContactUrl(page);
  if (!aiHref) return null;

  // 相対パスなら変換
  return new URL(aiHref, companyTopUrl).toString();
}
