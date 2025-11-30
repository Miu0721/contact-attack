import { openai } from './lib/openai.mjs';
import { extractTextFromResponse, parseJsonFromText } from './lib/ai-response.mjs';

// 問い合わせページらしさをスコアリングする関数
function scoreLinkForContact(link) {
  const text = link.text || '';
  const href = link.href || '';
  const t = `${text} ${href}`.toLowerCase();
  let score = 0;

  // ✅ 最優先：問い合わせ系ワード
  if (t.match(/お問い合わせ|お問合せ|お問合わせ|お問い合せ/)) score += 15;
  if (t.match(/\bcontact\b|\bcontact us\b|inquiry|support/)) score += 12;
  if (t.match(/フォーム|form/)) score += 4;
  if (t.match(/資料請求|ご相談|ご連絡/)) score += 6;

  // ✅ URL に contact / inquiry / support が入っていたら激アツ
  if (t.includes('/contact')) score += 20;
  if (t.includes('/inquiry')) score += 15;
  if (t.includes('/support')) score += 8;
  if (t.includes('/pages/contact')) score += 25; // Shopify系対策

  // ❌ 明確に除外したいもの
  if (t.match(/recruit|career|job|採用|求人/)) score -= 15;
  if (t.match(/privacy|ポリシー|規約|terms|利用規約/)) score -= 12;
  if (t.match(/about|会社概要|企業情報|corporate/)) score -= 8;
  if (t.match(/news|blog|press|ir|お知らせ/)) score -= 6;
  if (t.match(/login|ログイン|マイページ|mypage|会員登録|register|signup/)) score -= 10;
  if (t.match(/cart|カート|basket/)) score -= 10;

  // ❌ 検索・商品一覧・カテゴリっぽい URL は下げる
  if (t.includes('/search?') || t.includes('q=')) score -= 15;
  if (t.includes('/collections/')) score -= 10;
  if (t.includes('/items/list')) score -= 10;

  // ❌ SNS
  if (t.match(/twitter\.com|x\.com|facebook\.com|instagram\.com|line\.me|youtube\.com/)) {
    score -= 20;
  }

  // 深さも少しだけ考慮（深いほどちょっと減点）
  if (typeof link.depth === 'number') {
    score -= link.depth * 0.5;
  }

  return score;
}


function normalizeUrl(baseUrl, href) {
  try {
    const u = new URL(href, baseUrl);
    return u.toString();
  } catch {
    return null;
  }
}

async function collectLinksWithCrawl(page, companyTopUrl, maxDepth = 1, maxPages = 5) {
  const origin = (() => {
    try {
      return new URL(companyTopUrl).origin;
    } catch {
      return null;
    }
  })();

  const queue = [{ url: companyTopUrl, depth: 0 }];
  const visited = new Set();
  const links = [];

  while (queue.length && links.length < 500 && visited.size < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn('collectLinksWithCrawl: goto failed:', url, e.message);
      continue;
    }

    const pageLinks =
      (await page.$$eval('a', (as) =>
        as.map((a) => ({
          href: a.getAttribute('href') || '',
          text: (a.innerText || a.textContent || '').trim(),
        })),
      )) || [];

    for (const l of pageLinks) {
      const abs = normalizeUrl(url, l.href);
      if (!abs) continue;

      if (origin) {
        try {
          const o = new URL(abs).origin;
          if (o !== origin) continue; // 外部ドメインは除外
        } catch {
          continue;
        }
      }

      const entry = { href: abs, text: l.text, sourceUrl: url, depth };
      links.push(entry);

      if (!visited.has(abs) && depth + 1 <= maxDepth) {
        queue.push({ url: abs, depth: depth + 1 });
      }
    }
  }

  return links;
}

/** ①-2 AI に "問い合わせっぽいリンク" を選ばせる（複数indexを返してもOK） */
async function tryAIContactUrl(page, companyTopUrl, userPrompt) {
  console.log('🤖 tryAIContactUrl START', { url: page.url(), companyTopUrl });

  // まずは浅くクロールしてリンク候補を集める
  const links = await collectLinksWithCrawl(page, companyTopUrl);
  if (!links.length) {
    console.warn('collectLinksWithCrawl: リンク候補が1件も見つかりませんでした');
    return [];
  }

  // スコア付けして「問い合わせっぽい順」に並べる
  const scored = links.map((l) => ({
    ...l,
    score: scoreLinkForContact(l),
  }));
  scored.sort((a, b) => b.score - a.score);

  console.log(
    '🔗 上位スコアリンク(5件):',
    scored.slice(0, 5).map((l) => ({
      href: l.href,
      text: l.text,
      depth: l.depth,
      score: l.score,
    })),
  );

  // ルールベースでほぼ確実な問い合わせURLがあれば、AIを使わず即採用
  const strongRuleHit = scored.find((l) => {
    const t = `${l.text || ''} ${l.href || ''}`;
    const hasContactWord =
      t.includes('お問い合わせ') ||
      t.includes('お問合せ') ||
      t.toLowerCase().includes('contact');

    return hasContactWord && scoreLinkForContact(l) >= 10;
  });

  if (strongRuleHit) {
    console.log('✅ ルールベースで問い合わせURLを特定:', strongRuleHit.href);
    return [strongRuleHit.href];
  }

  // AI に渡すのは「スコア上位の一部だけ」
  const linksForAI = scored.slice(0, 150);
  console.log('🔗 AI に渡すリンク数:', linksForAI.length);

  const defaultPrompt = `
あなたは「企業サイトの中から最も問い合わせページらしいリンクを選択する」アシスタントです。

以下のリンク一覧（href とテキスト）から、
「お問い合わせページ」「問い合わせフォーム」「資料請求フォーム」「コンタクトページ」に該当するものを最大3件まで選んでください。

【優先して選ぶべきリンク】
- 「お問い合わせ」「お問合せ」「Contact」「Contact Us」「Inquiry」「Support」など
- 問い合わせフォーム・資料請求・サービスに関する問い合わせ
- フォームページへ遷移するもの（/contact/, /inquiry/, /support/, /form/ など）

【基本的には選ばないが、ページ内にお問い合わせフォームがある場合のみOK】
- 検索結果ページ（search や q= を含むURL）
- 商品一覧やカテゴリ一覧（/collections/, /items/list など）
- 採用・求人（Recruit, Career, Job, 採用情報）
- プライバシーポリシー、利用規約（policy, terms, privacy）
- 会社概要・企業情報（about, company, corporate）
- ニュース、ブログ、プレスリリース（news, blog, press, IR）
- SNSリンク（X/Twitter/Facebook/Instagram/LINE など）
- 決済ページ、会員ログイン、マイページ

【評価のルール】
- テキストと URL の両方から “問い合わせページらしさ” を総合判断してください。
- URL が /contact/, /inquiry/, /support/, /form/ を含む場合は優先度が高いです。
- 「お問い合わせ」を含むリンクは最優先で選んでください。

【出力形式】
以下の JSON のみを返してください（余計な文章は書かない）:

{
  "indexes": [番号, 番号, 番号]   // 0〜3件・優先度が高い順
}

該当するリンクが1つもない場合は:

{
  "indexes": []
}
  `.trim();

  const headPrompt =
    userPrompt && userPrompt.trim() ? userPrompt.trim() : defaultPrompt;

  const prompt = `
${headPrompt}

Base URL: ${companyTopUrl}

以下は候補リンクの一覧です（index, href, text, sourceUrl, depth, score）:
${JSON.stringify(linksForAI, null, 2)}

上記の「indexes」に入れるべき index を選んでください。
`.trim();

  const response = await openai.responses.create({
    model: 'gpt-5-mini',
    input: prompt,
    max_output_tokens: 20000,
  });

  const raw = extractTextFromResponse(response);
  if (!raw) return [];

  const parsed = parseJsonFromText(raw);
  if (!parsed) {
    console.warn('AI JSON parse失敗:', raw);
    return [];
  }

  // indexes (配列) or index (単一) を許容
  const indexes = Array.isArray(parsed.indexes)
    ? parsed.indexes
    : typeof parsed.index === 'number'
      ? [parsed.index]
      : [];

  const validIdx = indexes.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < linksForAI.length,
  );

  if (!validIdx.length) return [];

  const urls = [];
  for (const i of validIdx) {
    const chosen = linksForAI[i];
    if (!chosen) continue;
    urls.push(chosen.href); // href は絶対URLになっている前提
  }

  console.log('✅ AIが返した候補URL:', urls);
  return urls;
}

export async function findContactPageCandidates(page, companyTopUrl, userPrompt = '') {
  // まずトップを開いてリンクを収集
  try {
    await page.goto(companyTopUrl, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.warn('findContactPageCandidates: base goto failed:', e.message);
  }

  const aiUrls = await tryAIContactUrl(page, companyTopUrl, userPrompt);
  if (aiUrls.length) return aiUrls;

  // AIで空の場合、スコア順に上位3件返す
  const links = await collectLinksWithCrawl(page, companyTopUrl, 0);
  const scored = links
    .map((l) => ({ ...l, score: scoreLinkForContact(l) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((l) => l.href);

  return scored;
}
