// src/contact-form-analyzer.mjs
import { openai } from './lib/openai.mjs';
import { extractTextFromResponse, parseJsonFromText } from './lib/ai-response.mjs';

/**
 * 公開関数：
 * ページ全体（iframeも含めて）から
 * input / textarea / select を集めて AI に解析させる
 */
export async function analyzeContactFormWithAI(page, senderInfo = {}, message = '') {
  const result = await analyzeInContext(page, true, senderInfo, message);
  if (!result) {
    console.warn('iframe を含めてもフォーム入力フィールドが見つかりませんでした');
  }
  return result;
}

/**
 * Page / Frame 共通の処理
 * ctx: Playwright の Page または Frame
 * コンタクトページにある　フォームを解析して、全てのタグを返す関数。
 */
async function analyzeInContext(ctx, isRoot = false, senderInfo = {}, message = '') {
  await ctx.waitForTimeout(isRoot ? 2000 : 1000);

  // 何かしら出てくるのを一旦待つ
  await ctx
    .waitForSelector('form, input, textarea, select, iframe', {
      timeout: 8000,
    })
    .catch(() => {});

  // 1. まず form があればその outerHTML を使う。　なければ、input/textarea/select を拾う。
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

    return await callFormAnalyzerModel(formHtml, senderInfo, message);
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

      const res = await analyzeInContext(frame, false, senderInfo, message);
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
function buildSenderContext(senderInfo = {}, message = '') {
  const entries = Object.entries(senderInfo || {})
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`);

  const contextLines = [];
  if (entries.length) {
    contextLines.push('Sender info:');
    contextLines.push(...entries.map((e) => `- ${e}`));
  }
  if (message && message.trim()) {
    contextLines.push('Message:');
    contextLines.push(message.slice(0, 120) + (message.length > 120 ? '...' : ''));
  }
  return contextLines.length ? contextLines.join('\n') : '';
}

async function callFormAnalyzerModel(formHtml, senderInfo, message) {
  console.log('formHtml length:', formHtml.length);

  const MAX_LEN = 80000;
  const trimmedHtml =
    formHtml.length > MAX_LEN ? formHtml.slice(0, MAX_LEN) : formHtml;

  const senderContext = buildSenderContext(senderInfo, message);

  const prompt = `
  あなたは「HTMLお問い合わせフォーム解析ツール」です。
  
  ## タスク概要
  これから、問い合わせフォームまたは入力フィールド群の HTML を渡します。
  その中に含まれる <input>, <textarea>, <select> 要素（※後述の対象ルール参照）を解析し、
  それぞれのフィールドに対して、Sender情報をもとに「意味的な役割(role)」を 1 つだけ割り当ててください。
  
  対象となるサイトは主に **日本語サイト** です。
  ラベルや周辺テキスト、name/id 属性、placeholder の日本語からフィールドの意味を推測してください。
  
  ## この問い合わせの背景（重要）
  - 当社は **販売代行（営業代行）サービスの提案** を行うために、企業サイトの問い合わせフォームへ送信しています。
  - ただし、「役割(role)」は **あくまで HTML の意味に基づいて判断** し、  
    営業目的によって特別扱いはしないでください。  
    （例：どんな目的で送っていても、email フィールドは email、name フィールドは name）
  
  ## role の決定ルール（重要）
  - **推測しすぎないこと。迷ったら必ず "other" を使う。**
  - 「それっぽい」程度の曖昧な根拠では、役割を決めないでください。
  - 以下のように、意味が明確な場合のみ、より具体的な role を使ってください。
  
  ### その他
  - プライバシーポリシーは、すべて同意してください。（checkbox/radio がある場合）
  
  ## 含めるべきフィールド / 無視するフィールド
  ### 含める（出力対象）
  - ユーザーが入力・選択するデータ項目：
    - <input type="text|email|tel|number|password|radio|checkbox">
    - <textarea>
    - <select>
  
  ### 無視する（出力しない）
  - <input type="hidden">
  - <input type="submit|reset|button|image">
  - <button> などの純粋なボタン
  - 装飾用・技術的な要素で、ユーザーがデータを入力しないもの
  
  ### ラジオボタン / チェックボックス / セレクトボックス
  - 同じ質問項目に属する複数の radio / checkbox / option は、
    「1つの論理的フィールド」として扱ってください。
  - ラベルや周辺テキストから role を判定できる場合は付与し、
    判定できない場合は "other" にしてください。
  
  ## 出力フォーマット（厳守）
  **JSON オブジェクト 1 つだけ** を、次の構造で返してください。
  JSON 以外のテキスト（説明文、コメント、コードブロック記法など）は一切出力してはいけません。
  
  - 有効な JSON を返すこと（ダブルクォート必須、末尾カンマ禁止）。
  - name 属性や id 属性が存在しない場合は ""（空文字）を入れてください。
  - "label" には、そのフィールドを人間が見て認識するラベルを 1 つ入れてください：
    - 優先順位: <label> のテキスト > 近傍の説明テキスト > placeholder > name/id からの推測
  
  出力すべき JSON の構造（例：中身の値はダミーです）:
  
  {
    "fields": [
      {
        "nameAttr": "your_name",
        "idAttr": "name",
        "type": "text",
        "label": "お名前",
        "role": "name"
      },
      {
        "nameAttr": "your_email",
        "idAttr": "email",
        "type": "email",
        "label": "メールアドレス",
        "role": "email"
      }
    ]
  }
  
  ## 実際の入力
  これから、問い合わせフォームまたは入力フィールド群の HTML を渡します。
  上記のルールに従って解析し、上記フォーマットどおりの JSON オブジェクトを 1 つだけ出力してください。
  
  参考情報（入力候補のヒントに使ってよい）:
  ${senderContext || '(なし)'}
  
  対象 HTML:
  
  ${trimmedHtml}
  `.trim();

  
  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    input: prompt,
    max_output_tokens: 15000, // 少し多めに確保
    reasoning: { effort: 'low' }, // reasoning を抑えてテキストを出させる
  });

  console.log('📦 Form AI meta (debug):', {
    status: response.status,
    reason: response.incomplete_details?.reason,
    usage: response.usage,
  });

  const raw = extractTextFromResponse(response);
  console.log('🧠 Form AI raw response:', raw);

  if (!raw) {
    console.warn('フォームAIから空の返答');
    return null;
  }

  const parsedDirect = parseJsonFromText(raw);
  const jsonStr = raw;

  let parsed = parsedDirect;
  if (!parsed) {
    try {
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
  }

  if (!parsed || !Array.isArray(parsed.fields)) {
    console.warn('fields 配列が見つからない:', parsed);
    return null;
  }

  return parsed;
}
