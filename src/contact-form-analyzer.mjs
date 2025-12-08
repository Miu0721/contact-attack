
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
 * コンタクトページにある フォームを解析して、全ての入力タグ情報を返す関数。
 */
async function analyzeInContext(ctx, isRoot = false, senderInfo = {}, message = '') {
  // ページ内リソース読み込みの遅延に備え、待機時間を長めに確保
  await ctx.waitForTimeout(isRoot ? 4000 : 2000);

  // 何かしら出てくるのを一旦待つ
  await ctx
    .waitForSelector('form, main input, main textarea, main select, body > input, body > textarea, body > select, iframe', {
      timeout: 30000,
    })
    .catch(() => {});

  // 1. まず form があればその outerHTML を使う。なければ、input/textarea/select を拾う。
  const forms = await ctx.$$('form');

  let fieldsHtml = '';
  
  if (forms && forms.length > 0) {
    console.log('🧩 form タグを検出: count =', forms.length);
  
    for (const formHandle of forms) {
      const html = await formHandle.evaluate((form) => {
        const withinHeader = form.closest('header, nav');
        if (withinHeader) return '';
        return form.outerHTML;
      });
  
      if (html && html.trim()) {
        fieldsHtml = html;
        break; // 最初に見つかった「header/nav 以外の form」を採用
      }
    }
  
    if (!fieldsHtml) {
      console.warn(
        'ヘッダーやナビ内の form しか見つからなかったため、input/textarea/select のみを対象にします',
      );
    }
  }
  
  if (!fieldsHtml) {
    console.warn(
      'form タグが見つからなかったので、input/textarea/select のみを対象にします',
    );
    fieldsHtml = await ctx.$$eval(
      'main input, main textarea, main select, body > input, body > textarea, body > select',
      (elems) => elems.map((e) => e.outerHTML).join('\n'),
    );
  }
  

  if (fieldsHtml && fieldsHtml.trim()) {

    const count = (fieldsHtml.match(/<input|<textarea|<select/gi) || []).length;
    console.log('🧩 フィールド要素を検出:', count, '個');

    const formHtml = fieldsHtml.startsWith('<form')
      ? fieldsHtml
      : `<form>\n${fieldsHtml}\n</form>`; // 仮フォームとしてラップ

    // ← ★ ここでフィールド数ヒントも一緒に渡す
    return await callFormAnalyzerModel(formHtml, senderInfo, message, count);
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
 * Sender 情報をテキスト化してプロンプトに差し込む簡易ヘルパ
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
    contextLines.push(
      message.slice(0, 120) + (message.length > 120 ? '...' : ''),
    );
  }
  return contextLines.length ? contextLines.join('\n') : '';
}

/**
 * AI がダメだったとき用のフォールバック：
 * HTML から input/textarea/select をざっくり抜き出して role=other で返す
 */
function buildFallbackFieldsFromHtml(html) {
  const fields = [];
  const tagRe = /<(input|textarea|select)\b([^>]*)>/gi;
  let m;

  const getAttr = (attrs, name) => {
    const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
    const match = attrs.match(re);
    return match ? match[1] : '';
  };

  while ((m = tagRe.exec(html))) {
    const tag = (m[1] || '').toLowerCase();
    const attrs = m[2] || '';

    let type = tag;
    if (tag === 'input') {
      const t = getAttr(attrs, 'type').toLowerCase() || 'text';
      // hidden / submit / reset / button / image は無視
      if (/(hidden|submit|reset|button|image)/i.test(t)) continue;
      type = t;
    }

    const nameAttr = getAttr(attrs, 'name');
    const idAttr = getAttr(attrs, 'id');
    const placeholder = getAttr(attrs, 'placeholder');
    const label =
      placeholder || nameAttr || idAttr || (tag === 'textarea' ? '内容' : '');
    const required =
      /\srequired\b/i.test(attrs) ||
      /aria-required\s*=\s*["']?true["']?/i.test(attrs);

    fields.push({
      nameAttr: nameAttr || '',
      idAttr: idAttr || '',
      type,
      label,
      role: 'other', // 役割が特定できないので最低限 other で返す
      required,
    });
  }

  if (!fields.length) {
    console.warn('fallback でもフィールドを抽出できませんでした');
    return null;
  }

  console.log(`🧩 Fallback で ${fields.length} 個の field を生成しました`);
  return { fields };
}

/**
 * 実際に OpenAI に HTML を渡して JSON スキーマを返してもらう部分
 */
async function callFormAnalyzerModel(formHtml, senderInfo, message, fieldCountHint = null) {
  console.log('formHtml length:', formHtml.length);

  const MAX_LEN = 80000;
  const trimmedHtml =
    formHtml.length > MAX_LEN ? formHtml.slice(0, MAX_LEN) : formHtml;

  const senderContext = buildSenderContext(senderInfo, message);

  const fieldCountLine =
    typeof fieldCountHint === 'number'
      ? `この HTML には、input/textarea/select が合計でおよそ ${fieldCountHint} 個含まれています。\n`
      : '';

    const prompt = `
      あなたは「HTMLお問い合わせフォーム解析ツール」です。
      
      ## タスク概要
      これから、問い合わせフォームまたは入力フィールド群の HTML を渡します。
      その中に含まれる <input>, <textarea>, <select> 要素（※後述の対象ルール参照）を解析し、
      それぞれのフィールドに対して、Sender情報をもとに「意味的な役割(role)」を 1 つだけ割り当ててください。
      
      対象となるサイトは主に **日本語サイト** です。
      ラベルや周辺テキスト、name/id 属性、placeholder の日本語からフィールドの意味を推測してください。
      
      ${fieldCountLine || ''}
      
      ## この問い合わせの背景（重要）
      - 当社は **販売代行（営業代行）サービスの提案** を行うために、企業サイトの問い合わせフォームへ送信しています。
      - ただし、「役割(role)」は **あくまで HTML の意味に基づいて判断** し、
        営業目的によって特別扱いはしないでください。
        （例：どんな目的で送っていても、email フィールドは email、name フィールドは name）
      
      ## role の決定ルール（重要）
      - 各フィールドの "role" には、**必ず次のどれか 1 つだけ** を設定してください。
        - "name"
        - "lastName"
        - "firstName"
        - "nameKana"
        - "lastNameKana"
        - "firstNameKana"
        - "email"
        - "confirmEmail"
        - "company-name"
        - "department"
        - "phone"
        - "corporateSiteUrl"
        - "personalPhone"
        - "position"
        - "referral"
        - "gender"
        - "postalCode1"
        - "postalCode2"        
        - "postalCode"
        - "prefecture"
        - "address"
        - "age"
        - "city"
        - "town"
        - "street"
        - "building"
        - "streetAddress"
        - "subject"
        - "inquiryType"
        - "message"
        - "industry"
        - "companyType"
        - "phone1"
        - "phone2"
        - "phone3"
        - "country"
        - "companyNameKana"
        - "nameHira"
        - "firstNameHira"
        - "lastNameHira"
        - どれにも当てはまらない場合だけ "other"

      - **推測しすぎないこと。迷ったら必ず "other" を使う。**
      - 「それっぽい」程度の曖昧な根拠では、上の具体的な role を付けないでください。

      - 典型例（目安）：
        - 氏名・お名前 → "name"
        - 姓・苗字 → "lastName"
        - 名・下の名前 → "firstName"
        - お名前（フリガナ）全体 → "nameKana"
        - 姓（フリガナ） → "lastNameKana"
        - 名（フリガナ） → "firstNameKana"
        - お名前（ふりがな）全体 → "nameHira"
        - 名（ふりがな） → "firstNameHira"
        - 姓（ふりがな） → "lastNameHira"
        - メールアドレス → "email"
        - メールアドレス確認 → "confirmEmail"
        - 会社名・法人名・組織名 → "company-name"
        - 部署名 → "department"
        - 業種 → "industry"
        - 法人 / 個人の種別 → "companyType"
        - 電話番号（会社代表・連絡先としか書いていない場合を含む） → "phone"
        - 会社ホームページURL・コーポレートサイトURL → "corporateSiteUrl"
        - 担当者の個人携帯・個人電話番号と明記されている場合 → "personalPhone"
        - 役職（部長・課長・代表取締役 など） → "position"
        - 当社をどこで知りましたか・紹介元・流入経路 → "referral"
        - 性別 → "gender"
        - 郵便番号・〒（1入力の場合） → "postalCode"
        - 郵便番号の前半・後半（2入力の場合） → "postalCode1" / "postalCode2"
        - 電話番号の前半・中半・後半（3入力の場合） → "phone1" / "phone2" / "phone3"
        - 都道府県のみを入力させる項目 → "prefecture"
        - 市区町村のみ → "city"
        - 町名 → "town"
        - 番地・丁目など → "street"
        - 番地・丁目など(町名番地）をまとめて入力 → "streetAddress"
        - 建物名・部屋番号 → "building"
        - 住所（都道府県〜市区町村〜番地までまとめて入力） → "address"
        - 年齢・ご年齢・年代 → "age"
        - 「お問い合わせ種別」「お問い合わせの種類」など種別選択 → "inquiryType"
        - 件名・タイトル → "subject"
        - お問い合わせ内容・ご質問内容・ご相談内容 → "message"
        - 国 → "country"
        - 会社名（カナ） → "companyNameKana"
      - どれにもはっきり当てはまらない、または判断が難しい場合は **必ず "other"** にしてください。
      
      ### その他
      - プライバシーポリシーへの同意チェックボックスなども、「ユーザーがチェックする要素」であればフィールドとして含めて構いません。
      
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
      - role が "inquiryType" で、type が radio/checkbox/select の場合、
        選択肢ラベルのうち **AI が選ぶべきもの** を 1 つ決め、フィールドに "preferredOption" で入れてください。
        - 選ぶ優先順位: 「営業」「セールス」「販売代行」など営業関連キーワードがある選択肢を最優先。
        - 営業関連が見つからなければ、「その他」「その他・その他」「その他(その他)」などの「その他」系を選んでください。
      - 郵便番号フィールドの判定ルール：
        - 同じ郵便番号枠に input が2つある場合は、1つ目を role="postalCode1"、2つ目を role="postalCode2" にする。
        - input が1つだけなら role="postalCode" とする。
        - input が3つ以上ある場合はロール判定が難しいので "other" で構いません。
      - 住所フィールドの判定ルール：
        - 都道府県・市区町村・町域・番地・建物などが分割されている場合、それぞれ "prefecture" / "city" / "town" / "street" / "building" を付けてください。
        - 住所が1つの入力でまとめられている場合は "address" を使ってください。
      
      ## 重要な制約（必ず守ること）
      - **入力フィールドが 1つ以上存在する場合は、"fields" 配列を空 [] のまま返してはいけません。**
      - input/textarea/select が存在するのに "fields": [] だけを返すのは **禁止** です。
      - もし役割が全く分からなくても、各フィールドを少なくとも 1件ずつ
        - nameAttr / idAttr / type / label / required を埋め、
        - role: "other"
        として出力してください。
      
      ## 出力フォーマット（厳守）
      **JSON オブジェクト 1 つだけ** を、次の構造で返してください。
      JSON 以外のテキスト（説明文、コメント、コードブロック記法など）は一切出力してはいけません。
      
      - 有効な JSON を返すこと（ダブルクォート必須、末尾カンマ禁止）。
      - name 属性や id 属性が存在しない場合は ""（空文字）を入れてください。
      - "required" は、そのフィールドが必須なら true、そうでなければ false にしてください（判定できない場合も false）。
      - "label" には、そのフィールドを人間が見て認識するラベルを 1 つ入れてください：
        - 優先順位: <label> のテキスト > 近傍の説明テキスト > placeholder > name/id からの推測
      - "role" は 1つの文字列で指定してください。placeholder や label などに複数の項目（例: 「部署・役職」）が明示されている場合のみ、"roles" に配列で複数の役割候補を併記して構いません（例: ["department","position"]）。"role" には最も優先したい 1 つだけを入れてください。
      - radio/checkbox/select で role が inquiryType の場合は、
        "preferredOption" に **選択肢の表示テキスト** を 1 つ入れてください（わからなければ ""）。
      
      出力すべき JSON の構造（例：中身の値はダミーです）:
      
      {
        "fields": [
          {
            "nameAttr": "your_name",
            "idAttr": "name",
            "type": "text",
            "label": "お名前",
            "role": "name",
            "required": true
          },
          {
            "nameAttr": "your_email",
            "idAttr": "email",
            "type": "email",
            "label": "メールアドレス",
            "role": "email",
            "required": true
          },
          {
            "nameAttr": "type",
            "idAttr": "",
            "type": "radio",
            "label": "お問い合わせ種別",
            "role": "inquiryType",
            "required": false,
            "preferredOption": "案件のご依頼"
          }
        ]
      }
      
      ## 参考情報（入力値の例）
      以下は、この問い合わせで実際に送信する可能性がある値の例です。
      フィールドの意味を推測するためのヒントとして使っても構いませんが、
      必ずしもこれらの値に合わせる必要はありません。
      
      ${senderContext || '(なし)'}
      
      ## 対象 HTML
      
      これから、問い合わせフォームまたは入力フィールド群の HTML を渡します。
      上記ルールに従って解析し、必ず 1つの JSON オブジェクトだけを出力してください。
      
      対象 HTML:
      
      ${trimmedHtml}
      `.trim();
      

  const response = await openai.responses.create({
    model: 'gpt-5-mini',
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
    // AI が完全に沈黙 → フォールバック（フィールド数ヒントがあれば）
    if (fieldCountHint && fieldCountHint > 0) {
      return buildFallbackFieldsFromHtml(trimmedHtml);
    }
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

      // ★ フォールバック："fields": [ ... ] の JSON 部分だけを抜き出してパース
      const fields = [];

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
        // ここでも、フィールドがあると分かっている場合はローカルフォールバック
        if (fieldCountHint && fieldCountHint > 0) {
          return buildFallbackFieldsFromHtml(trimmedHtml);
        }
        return null;
      }

      console.log(`🧩 Fallback で ${fields.length} 個の field を復元しました(JSON 部分抽出)`);
      parsed = { fields };
    }
  }

  // ここまでで parsed は何かしらのオブジェクトになっているはず
  if (!parsed || !Array.isArray(parsed.fields)) {
    console.warn('fields 配列が見つからない:', parsed);
    if (fieldCountHint && fieldCountHint > 0) {
      return buildFallbackFieldsFromHtml(trimmedHtml);
    }
    return null;
  }

  // ★ ここが今回一番効くやつ：
  //   「input/textarea/select があるのに fields が空」の場合は AI を信用せずローカルフォールバック
  if (parsed.fields.length === 0 && fieldCountHint && fieldCountHint > 0) {
    console.warn(
      `AI が fields を空配列で返しましたが、推定フィールド数=${fieldCountHint} なのでローカルフォールバックを実行します`,
    );
    const fb = buildFallbackFieldsFromHtml(trimmedHtml);
    if (fb) return fb;
  }

  return parsed;
}
