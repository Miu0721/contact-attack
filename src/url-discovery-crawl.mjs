// src/url-discovery-crawl.mjs

const DEFAULT_MAX_DEPTH = 2;   // Top から 2ステップ先まで
const DEFAULT_MAX_PAGES = 30;  // 最大 30 ページまでクロール

/**
 * サイトを浅くクロールして、問い合わせ候補になりそうなリンク一覧を集める。
 *
 * @param {import('playwright').Page} page Playwright の Page インスタンス（1枚を使い回す）
 * @param {string} startUrl  クロール開始URL（通常は企業サイトのトップ）
 * @param {Object} options
 * @param {number} [options.maxDepth=2]  深さ制限（Top=0, Top配下=1, その配下=2）
 * @param {number} [options.maxPages=30] 最大クロールページ数
 * @returns {Promise<Array<{ href: string, text: string, sourceUrl: string, depth: number }>>}
 */
export async function crawlSiteForContact(page, startUrl, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  let origin;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    console.warn('crawlSiteForContact: invalid startUrl', startUrl);
    return [];
  }

  // BFS 用キュー
  const queue = [{ url: startUrl, depth: 0 }];
  const visited = new Set();
  const candidates = [];

  while (queue.length && visited.size < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`🌐 crawl(depth=${depth}):`, url);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn('crawlSiteForContact: goto failed:', url, e.message);
      continue;
    }

    // a タグからリンク情報取得
    const rawLinks = await page.$$eval('a', (as) =>
      as.map((a) => ({
        href: a.getAttribute('href') || '',
        text: (a.innerText || a.textContent || '').trim(),
      })),
    );

    // href のフィルタ & 絶対URL化 & 同一ドメインに限定
    const links = rawLinks
      .filter((l) => !!l.href)
      .filter((l) => {
        const href = l.href.trim();
        if (!href || href === '#' || href.startsWith('#')) return false;
        if (href.startsWith('mailto:')) return false;
        if (href.startsWith('tel:')) return false;
        if (href.toLowerCase().startsWith('javascript:')) return false;
        return true;
      })
      .map((l) => {
        try {
          const abs = new URL(l.href, url).toString(); // 今のページを基準に絶対URL化
          return { href: abs, text: l.text };
        } catch {
          return null;
        }
      })
      .filter((l) => !!l)
      .filter((l) => {
        try {
          const o = new URL(l.href).origin;
          return o === origin; // 他ドメインはクロールしない
        } catch {
          return false;
        }
      });

    // 収集 & 次のクロール対象としてキューへ
    for (const l of links) {
      const entry = {
        href: l.href,
        text: l.text,
        sourceUrl: url,
        depth,
      };
      candidates.push(entry);

      if (depth < maxDepth && !visited.has(l.href)) {
        queue.push({ url: l.href, depth: depth + 1 });
      }
    }
  }

  return candidates;
}
