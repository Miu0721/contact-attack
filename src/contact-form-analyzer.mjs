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
    あなたは「HTMLお問い合わせフォーム解析ツール」です。
    
    ## タスク概要
    これから、問い合わせフォームまたは入力フィールド群の HTML を渡します。
    その中に含まれる <input>, <textarea>, <select> 要素（※後述の対象ルール参照）を解析し、
    それぞれのフィールドに対して「意味的な役割(role)」を 1 つだけ割り当ててください。
    
    対象となるサイトは主に **日本語サイト** です。
    ラベルや周辺テキスト、name/id 属性、placeholder の日本語からフィールドの意味を推測してください。
    
    ## 付与できる role 一覧
    各フィールドには、以下のいずれか 1 つの role を必ず割り当てます。
    
    - "name"             : 氏名・お名前（担当者名, お名前 など、姓と名が分かれていない場合）
    - "first_name"       : 名（下の名前, first name）
    - "last_name"        : 姓（苗字, last name）
    - "name_kana"        : 氏名（フリガナ）全体
    - "first_name_kana"  : 名のフリガナ
    - "last_name_kana"   : 姓のフリガナ
    - "email"            : メールアドレス
    - "company"          : 会社名・法人名（御社名, 貴社名 など）
    - "department"       : 部署・所属・役職を含む職位（部署名, 役職名 など）
    - "phone"            : 電話番号（会社か個人か不明な場合や混在している場合）
    - "company_phone"    : 会社の電話番号（代表番号, 会社電話番号 など明確に会社用と書かれている場合）
    - "personal_phone"   : 個人・携帯電話番号（携帯番号, ご本人様の電話番号 など明確に個人用の場合）
    - "title"            : 役職（役職, 肩書き など）
    - "subject"          : 件名・タイトル（お問い合わせ件名, 題名 など）
    - "body"             : お問い合わせ内容・相談内容・本文（自由記入のメインメッセージ）
    - "category"         : お問い合わせ種別・ご用件の種別（資料請求 / お問い合わせ種別 / ご用件など）
    - "inquiry_category" : "category" と同義。実質お問い合わせ種別とみなせる場合に使用可
    - "referral"         : 当サイトを知ったきっかけ（どこで知りましたか, 紹介者, 流入経路 など）
    - "gender"           : 性別
    - "postal_code"      : 郵便番号（〒, 郵便番号）
    - "prefecture"       : 都道府県
    - "address"          : 住所（市区町村・番地・建物名など。都道府県や郵便番号を除く残りの住所）
    - "age"              : 年齢
    - "other"            : 上記のどれにもはっきり当てはまらないもの
    
    ## role の決定ルール（重要）
    - **推測しすぎないこと。迷ったら必ず "other" を使う。**
    - 「それっぽい」程度の曖昧な根拠では、役割を決めないでください。
    - 以下のように、意味が明確な場合のみ、より具体的な role を使ってください。
    
    ### 氏名まわり
    - 「姓」「苗字」「last name」 → "last_name"
    - 「名」「first name」 → "first_name"
    - 「お名前」「氏名」 で姓・名の分割がない → "name"
    - 「フリガナ」「ふりがな」全体 → "name_kana"
    - 「セイ」「姓(フリガナ)」 → "last_name_kana"
    - 「メイ」「名(フリガナ)」 → "first_name_kana"
    
    ### 電話番号まわり
    - 「会社電話番号」「代表番号」「会社の連絡先」など → "company_phone"
    - 「携帯電話」「ご本人様の電話番号」「携帯番号」など → "personal_phone"
    - 会社用か個人用か判別できない → "phone"
    
    ### 住所まわり
    - 「郵便番号」「〒」のみ → "postal_code"
    - 「都道府県」のみ → "prefecture"
    - 市区町村・番地・建物名などの住所 → "address"
    
    ### お問い合わせ内容・種別
    - 「お問い合わせ内容」「ご相談内容」「メッセージ本文」など → "body"
    - 「お問い合わせ種別」「ご用件」「お問い合わせの種類」など → "category" または "inquiry_category"
      - どちらを使ってもよいが、同じフォーム内では基本的にどちらか一方に統一すること。
    
    ### その他
    - 「どこで当サイトを知りましたか」「当サイトを知ったきっかけ」 → "referral"
    - 「性別」 → "gender"
    - 「年齢」「ご年齢」 → "age"
    - プライバシーポリシーは、全て、同意してください。

    
    ## 含めるべきフィールド / 無視するフィールド
    ### 含める（出力対象）
    - ユーザーが入力・選択するデータ項目：
      - <input type="text|email|tel|number|password|radio|checkbox">
      - <textarea>
      - <select>
    
    ### 無視する（出力しない）
    - <input type="hidden">
    - 送信ボタン・リセットボタンなど：
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
    
    対象 HTML:
    
    ${trimmedHtml}
    `.trim();
    

  const response = await openai.responses.create({
    model: 'gpt-5-nano',
    input: prompt,
    max_output_tokens: 15000,        // 少し多めに確保
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
