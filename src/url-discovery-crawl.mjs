// src/url-discovery-crawl.mjs

const MAX_CRAWL_DEPTH = 2;
const MAX_CRAWL_PAGES = 20;

export async function collectLinksWithCrawl(page, startUrl, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_CRAWL_DEPTH;
  const maxPages = options.maxPages ?? MAX_CRAWL_PAGES;

  let origin;
  try {
    origin = new URL(startUrl).origin;
  } catch {
    console.warn('collectLinksWithCrawl: invalid startUrl', startUrl);
    return [];
  }

  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  const allLinks = [];

  while (queue.length && visited.size < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`🌐 crawl(depth=${depth}):`, url);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn('goto error:', url, e.message);
      continue;
    }

    const rawLinks = await page.$$eval('a', (as) =>
      as.map((a) => ({
        href: a.getAttribute('href') || '',
        text: (a.innerText || a.textContent || '').trim(),
      }))
    );

    const links = rawLinks
      .filter((l) => !!l.href)
      .filter((l) => {
        const href = l.href.trim();
        if (!href || href === '#' || href.startsWith('#')) return false;
        if (href.startsWith('mailto:')) return false;
        if (href.startsWith('tel:')) return false;
        if (href.toLowerCase().startsWith('javascript:')) return false;

        try {
          const a = new URL(href, origin);
          return a.origin === origin;
        } catch {
          return false;
        }
      });

    for (const l of links) {
      let abs;
      try {
        abs = new URL(l.href, origin).toString();
      } catch {
        continue;
      }

      allLinks.push({
        href: abs,
        text: l.text,
        sourceUrl: url,
        depth,
      });

      if (depth < maxDepth && !visited.has(abs)) {
        queue.push({ url: abs, depth: depth + 1 });
      }
    }
  }

  return allLinks;
}
