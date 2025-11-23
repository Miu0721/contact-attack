// src/contact-form-analyzer.mjs
import { openai } from './lib/openai.mjs';

/**
 * 公開関数：
 * ページ全体（iframeも含めて）から
 * input / textarea / select を集めて AI に解析させる
 */
export async function analyzeContactFormWithAI(page) {
  const result = await analyzeInContext(page, true);
  if (!result) {
    console.warn('iframe を含めてもフォーム入力フィールドが見つかりませんでした');
  }
  console.log('analyzeContactFormWithAIのところ')
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Page / Frame 共通の処理
 * ctx: Playwright の Page または Frame
 */
async function analyzeInContext(ctx, isRoot = false) {
  // JSレンダリング待ち
  if (isRoot) {
    await ctx.waitForTimeout(2000);
  } else {
    await ctx.waitForTimeout(1000);
  }

  // 何かしら出てくるのを一旦待つ
  await ctx
    .waitForSelector('form, input, textarea, select, iframe', {
      timeout: 8000,
    })
    .catch(() => {});

  // 1. まず form があればその outerHTML を使う
  const forms = await ctx.$$('form');

  let fieldsHtml = '';

  if (forms && forms.length > 0) {
    console.log('🧩 form タグを検出: count =', forms.length);
    fieldsHtml = await ctx.$eval('form', (form) => form.outerHTML);
  } else {
    console.warn(
      'form タグが見つからなかったので、input/textarea/select のみを対象にします',
    );
    fieldsHtml = await ctx.$$eval(
      'input, textarea, select',
      (elems) => elems.map((e) => e.outerHTML).join('\n'),
    );
  }

  if (fieldsHtml && fieldsHtml.trim()) {
    const count =
      (fieldsHtml.match(/<input|<textarea|<select/g) || []).length;
    console.log('🧩 フィールド要素を検出:', count, '個');

    const formHtml = fieldsHtml.startsWith('<form')
      ? fieldsHtml
      : `<form>\n${fieldsHtml}\n</form>`; // 仮フォームとしてラップ

    return await callFormAnalyzerModel(formHtml);
  }

  // 2. このコンテキストに入力フィールドが無い → iframeを探索
  const iframes = await ctx.$$('iframe');
  if (!iframes.length) {
    console.warn(
      '入力フィールドも iframe も見つかりませんでした（このコンテキスト）',
    );
    return null;
  }

  console.log('🔍 iframe 内も探索します: count =', iframes.length);

  for (const iframe of iframes) {
    try {
      const frame = await iframe.contentFrame();
      if (!frame) continue;

      const res = await analyzeInContext(frame, false);
      if (res) return res; // iframe 内で解析できたらそれを返す
    } catch (e) {
      console.warn('iframe 探索中にエラー:', e.message);
    }
  }

  // すべての iframe の中もダメだった
  return null;
}

/**
 * 実際に OpenAI に HTML を渡して JSON スキーマを返してもらう部分
 */
async function callFormAnalyzerModel(formHtml) {
  console.log('formHtml length:', formHtml.length);
  console.log(formHtml.slice(0, 500));
  console.log('--- tail ---');
  console.log(formHtml.slice(-500));
  const MAX_LEN = 80000;
  const trimmedHtml =
    formHtml.length > MAX_LEN ? formHtml.slice(0, MAX_LEN) : formHtml;

  const prompt = `
You are an HTML contact form analyzer.
I will give you the HTML of a contact/inquiry form or a group of input fields.
Inspect the <input>, <textarea>, and <select> fields and assign a semantic role to each field.

Possible roles (use one of these strings):
- "name"         : person's name (担当者名, お名前)
- "name_kana"    : name in kana (フリガナ)
- "email"        : email address
- "company"      : company/organization name
- "department"   : department or job title
- "phone"        : phone number or mobile number
- "subject"      : subject/title of the inquiry
- "body"         : main message / inquiry content
- "category"     : inquiry type/category (資料請求 / お問い合わせ種別)
- "other"        : any other fields

Return ONLY a JSON object in this exact format (no extra text):

{
  "fields": [
    {
      "nameAttr": "...",        // value of name="" or "" if missing
      "idAttr": "...",          // value of id="" or "" if missing
      "type": "...",            // e.g. text, email, tel, textarea, select
      "label": "...",           // best guess: label/placeholder/aria-label
      "role": "..."             // one of the roles above
    }
  ]
}

Here is the HTML of the form or field group:

${trimmedHtml}
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    input: prompt,
    max_output_tokens: 80000,        // 少し多めに確保
    reasoning: { effort: 'low' },  // reasoning を抑えてテキストを出させる
  });

  console.log('📦 Form AI meta (debug):', {
    status: response.status,
    reason: response.incomplete_details?.reason,
    usage: response.usage,
  });

  // シンプルに output_text だけを見る
  let raw = (response.output_text || '').trim();

  console.log('🧠 Form AI raw response:', raw);

  if (!raw) {
    console.warn('フォームAIから空の返答');
    return null;
  }

  // { ... } だけ抜き出して JSON.parse
  const match = raw.match(/\{[\s\S]*\}/);
  let jsonStr = match ? match[0] : raw;

  let parsed;
  try {
    // まずは素直に JSON.parse を試す
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('フォームAI JSON parse失敗 (1st):', jsonStr);

    // ★ フォールバック：
    // "fields": [ ... ] の JSON 部分だけを抜き出してパース
    const fields = [];

    // 1) "fields" の配列部分を抽出（ブラケットの対応を見てスライス）
    const fieldsIdx = jsonStr.indexOf('"fields"');
    if (fieldsIdx !== -1) {
      const startBracket = jsonStr.indexOf('[', fieldsIdx);
      if (startBracket !== -1) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startBracket; i < jsonStr.length; i += 1) {
          const ch = jsonStr[i];
          if (ch === '[') depth += 1;
          else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }

        if (endIdx !== -1) {
          const arrText = jsonStr.slice(startBracket, endIdx + 1);
          try {
            const parsedFields = JSON.parse(arrText);
            if (Array.isArray(parsedFields)) {
              for (const f of parsedFields) {
                if (f && typeof f === 'object') fields.push(f);
              }
            }
          } catch (_ignore) {
            // 2) 個別オブジェクトを拾うフォールバック
            const body = jsonStr.slice(startBracket + 1, endIdx);
            const objectMatches = body.match(/\{[^{}]*\}/g) || [];
            for (const objText of objectMatches) {
              try {
                const fieldObj = JSON.parse(objText);
                fields.push(fieldObj);
              } catch (_ignore2) {
                // 破損行は無視
              }
            }
          }
        }
      }
    }

    if (!fields.length) {
      console.warn('フォームAI JSON parse失敗 (fallbackも失敗):', jsonStr);
      return null;
    }

    console.log(`🧩 Fallback で ${fields.length} 個の field を復元しました`);
    parsed = { fields };
  }

  if (!parsed || !Array.isArray(parsed.fields)) {
    console.warn('fields 配列が見つからない:', parsed);
    return null;
  }

  return parsed;
}
