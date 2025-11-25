// src/lib/ai-response.mjs
// 小さなユーティリティ: OpenAI Responses API からテキストを安全に抜き出し、
// JSON だけを取り出す。

/**
 * responses.create() の戻り値からテキスト部分だけを抽出する。
 * output_text が空でも output の中に文字列がある場合を拾う。
 */
export function extractTextFromResponse(response) {
  if (!response) return '';

  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  try {
    const first = Array.isArray(response.output) ? response.output[0] : null;
    const firstContent = first?.content?.[0];

    if (!firstContent) return '';

    if (typeof firstContent === 'string') return firstContent.trim();
    if (typeof firstContent.text === 'string') return firstContent.text.trim();
    if (typeof firstContent.text?.value === 'string') {
      return firstContent.text.value.trim();
    }
  } catch (_err) {
    // ignore extraction errors
  }

  return '';
}

/**
 * 生テキストから最初に見つかった JSON ブロックをパースする。
 * 見つからなければ null を返す。
 */
export function parseJsonFromText(raw) {
  const text = (raw || '').trim();
  if (!text) return null;

  const match = text.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : text;

  try {
    return JSON.parse(jsonStr);
  } catch (_err) {
    return null;
  }
}
