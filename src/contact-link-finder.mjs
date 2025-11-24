// src/contact-link-finder.mjs
import { openai } from './lib/openai.mjs';

/**
 * 現在の page から <a> リンク一覧を取得し、
 * gpt-4o-mini に「どれが問い合わせフォームっぽいか？」を選ばせて
 * 絶対URLで返す関数。
 * userPrompt を渡すと、そのプロンプトを元に選択させる。
 *
 * 見つからなければ null を返す。
 */
/**
 * 文字列URLを渡して問い合わせリンク候補を探すラッパー。
 * - 指定URLへ遷移してから既存ロジックでリンクを推定する。
 */
export async function findContactPageUrlWithAIFromUrl(page, targetUrl, userPrompt) {
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.warn('指定URLへの移動に失敗しました:', targetUrl, e.message);
    return null;
  }

  return findContactPageUrlWithAI(page, userPrompt);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} [userPrompt] AI に渡す追加/上書きプロンプト。未指定なら既定の指示を使用。
 */
export async function findContactPageUrlWithAI(page, userPrompt) {
  const baseUrl = page.url();

  // 1. ページ内の <a> 要素を全部取る
  const links = await page.$$eval('a', (anchors) =>
    anchors
      .map((a) => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').trim(),
      }))
      .filter((l) => l.href && !l.href.startsWith('javascript:'))
  );

  if (links.length === 0) {
    console.warn('リンクが1件も見つかりませんでした');
    return null;
  }

  // 2. gpt に渡す用に整形（多すぎるときは上位100件くらいに絞る）
  const limited = links.slice(0, 100);

  const listForModel = limited
    .map(
      (l, i) =>
        `${i}: text="${l.text || '(no text)'}", href="${l.href}"`
    )
    .join('\n');

  const defaultPrompt = `
You are helping to find a "contact / inquiry / お問い合わせ" page link from a website's navigation.
Exclude job/recruit/career, privacy/policy/terms, news/blog/press/IR, and SNS links.
Choose the most likely contact/inquiry/support/request form link.
  `.trim();

  const headPrompt =
    userPrompt && userPrompt.trim() ? userPrompt.trim() : defaultPrompt;

  const prompt = `
${headPrompt}

Base URL: ${baseUrl}

Here is a list of links on the page (index, text, href):

${listForModel}

Return ONLY this JSON (no extra text):
{"index": <number>, "reason": "<short reason>"}

If none look like a contact page, return:
{"index": -1, "reason": "no contact page"}
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
    max_output_tokens: 20000,
  });

  // ▼ ここを「より安全」にした：output_text が空でも他のパスを見に行く
  let raw = '';

  try {
    if (response.output_text) {
      raw = response.output_text;
    } else if (response.output && response.output.length > 0) {
      // Responses API の標準構造からテキストを取り出す fallback
      const firstItem = response.output[0];
      const firstContent = firstItem.content?.[0]?.text;
      if (firstContent) {
        raw = firstContent.value ?? firstContent;
      }
    }
  } catch (e) {
    console.warn('AI レスポンスのテキスト抽出に失敗しました:', e);
  }

  raw = (raw || '').trim();
  console.log('🧠 AI raw response:', raw);

  if (!raw) {
    console.warn('AI から空の返答が返ってきました');
    return null;
  }

  // ▼ 余計な文字が混ざっても、{} の部分だけ抜き取って JSON.parse する
  let jsonStr = raw;
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    jsonStr = match[0];
  }

  let index = -1;
  try {
    const parsed = JSON.parse(jsonStr);
    index = parsed.index;
  } catch (e) {
    console.warn('AI からの返答の JSON 解析に失敗しました:', jsonStr);
    return null;
  }

  if (
    typeof index !== 'number' ||
    index < 0 ||
    index >= limited.length
  ) {
    console.warn('AI が有効な index を返しませんでした:', index);
    return null;
  }

  const chosen = limited[index];

  // 4. 相対URLなら絶対URLに変換
  let fullUrl;
  try {
    fullUrl = new URL(chosen.href, baseUrl).toString();
  } catch (e) {
    console.warn('URL の組み立てに失敗しました:', chosen.href);
    return null;
  }

  console.log('🔍 AI が選んだ問い合わせ候補URL:', fullUrl);
  return fullUrl;
}
