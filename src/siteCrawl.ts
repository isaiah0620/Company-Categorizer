import { config } from './config.js';
import { stripImages } from './cleanMarkdown.js';
import { extractWithTavily, mapWithTavily, type ExtractedPage } from './tavily.js';
import type { ScrapeResult } from './types.js';

/**
 * Multi-page crawl built entirely on Tavily:
 *
 *   1. Map    -> every URL Tavily can reach from the homepage   (-> `sitemap` column)
 *   2. Select -> the few pages most likely to say what the company does
 *   3. Extract-> markdown for those pages, in ONE request
 *   4. Build  -> labelled, cleaned, size-capped text            (-> `scraped_text` column,
 *                                                                 and the model's input)
 *
 * Note on "sitemap": Tavily Map discovers pages by following links from the
 * homepage; it does not read /sitemap.xml. For typical company sites the
 * result is the same, but a page nothing links to won't appear.
 */

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

const ASSET_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|xml|json|css|js|mp3|mp4|mov|docx?|xlsx?|pptx?)$/i;

/** Path segments (or fragments of them) that make a page worth reading, with weights. */
const WANTED: Array<[string, number]> = [
  ['about', 10],
  ['who-we-are', 10],
  ['our-story', 9],
  ['company', 8],
  ['firm', 8],
  ['what-we-do', 10],
  ['services', 10],
  ['solutions', 9],
  ['offerings', 9],
  ['capabilities', 9],
  ['expertise', 8],
  ['products', 9],
  ['industries', 8],
  ['sectors', 8],
  ['portfolio', 9],
  ['investments', 9],
  ['investment', 9],
  ['criteria', 10],
  ['approach', 8],
  ['strategy', 8],
  ['focus', 7],
  ['philosophy', 6],
  ['mission', 6],
  ['team', 6],
  ['leadership', 6],
  ['clients', 5],
];

/** Segments that are never worth the tokens. */
const UNWANTED = new Set([
  'blog', 'blogs', 'news', 'press', 'media', 'articles', 'article', 'post', 'posts',
  'careers', 'career', 'jobs', 'job', 'privacy', 'privacy-policy', 'terms', 'terms-of-service',
  'cookie', 'cookies', 'legal', 'disclaimer', 'login', 'log-in', 'signin', 'sign-in', 'signup',
  'register', 'cart', 'checkout', 'account', 'tag', 'tags', 'category', 'categories', 'author',
  'feed', 'wp-content', 'wp-json', 'wp-admin', 'sitemap', 'search',
]);

function hostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Stable comparison key: host without www, path without trailing slash, no query/hash. */
function normKey(u: URL): string {
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${hostKey(u.hostname)}${path.toLowerCase()}`;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function segmentsOf(u: URL): string[] {
  return u.pathname
    .toLowerCase()
    .split('/')
    .filter(Boolean);
}

/** Same-site, http(s), fragment-free, de-duplicated, order preserved. */
export function cleanSitemap(baseUrl: string, discovered: string[]): string[] {
  const base = parse(baseUrl);
  if (!base) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of discovered) {
    const u = parse(raw);
    if (!u || !/^https?:$/.test(u.protocol)) continue;
    if (hostKey(u.hostname) !== hostKey(base.hostname)) continue;
    u.hash = '';
    // Query strings are kept in the stored sitemap but de-duplicated by path+query.
    const key = `${normKey(u)}${u.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Page selection                                                      */
/* ------------------------------------------------------------------ */

function scoreUrl(u: URL): number | null {
  // null = never extract this URL
  if (u.search) return null;
  if (ASSET_EXT.test(u.pathname)) return null;
  const segs = segmentsOf(u);
  if (segs.some((s) => UNWANTED.has(s))) return null;

  let best = 0;
  for (const seg of segs) {
    for (const [keyword, weight] of WANTED) {
      if (seg === keyword || seg.includes(keyword)) best = Math.max(best, weight);
    }
  }
  // Shallow pages describe the business; deep ones are usually one product or one person.
  return best - segs.length * 0.5;
}

/**
 * Homepage first, then the best-scoring "what do they do" pages, then (if
 * there's still room) the shallowest remaining pages, which catches sites
 * whose "about" page is called something unexpected.
 */
export function selectPages(baseUrl: string, sitemap: string[], maxPages: number): string[] {
  const base = parse(baseUrl);
  const selected: string[] = [baseUrl];
  if (!base || maxPages <= 1) return selected;

  const taken = new Set([normKey(base)]);
  const candidates: Array<{ url: string; score: number; depth: number }> = [];

  for (const raw of sitemap) {
    const u = parse(raw);
    if (!u) continue;
    const key = normKey(u);
    if (taken.has(key)) continue;
    const score = scoreUrl(u);
    if (score === null) continue;
    candidates.push({ url: raw, score, depth: segmentsOf(u).length });
  }

  const wanted = candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  const filler = candidates
    .filter((c) => c.score <= 0 && c.depth <= 1)
    .sort((a, b) => a.depth - b.depth || a.url.length - b.url.length);

  for (const c of [...wanted, ...filler]) {
    if (selected.length >= maxPages) break;
    const u = parse(c.url);
    if (!u) continue;
    const key = normKey(u);
    if (taken.has(key)) continue;
    taken.add(key);
    selected.push(c.url);
  }
  return selected;
}

/* ------------------------------------------------------------------ */
/* Text assembly                                                       */
/* ------------------------------------------------------------------ */

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  const clean = lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut;
  return `${clean.trimEnd()}\n[...truncated]`;
}

/**
 * Postgres TEXT and JSONB both reject the NUL character, and scraped pages
 * occasionally contain one. Left in, it fails the INSERT/UPDATE outright.
 */
export function stripNul(text: string): string {
  return text.replace(/\u0000/g, '');
}

/**
 * Cleans each page (drops base64 images / inline SVG), caps it, labels it
 * with its URL, and stops adding pages once the total budget is spent.
 * What comes out is exactly what is sent to the model AND what is stored in
 * scraped_text, so the column is a faithful record of the model's input.
 */
export function buildScrapedText(pages: ExtractedPage[]): { text: string; included: string[] } {
  const { maxCharsPerPage, maxTotalChars } = config.siteCrawl;
  const parts: string[] = [];
  const included: string[] = [];
  let used = 0;

  for (const page of pages) {
    const cleaned = stripNul(stripImages(page.markdown));
    if (!cleaned) continue;

    const header = `=== PAGE: ${page.url} ===\n`;
    const room = maxTotalChars - used - header.length;
    if (room < 200) break;

    const body = truncate(cleaned, Math.min(maxCharsPerPage, room));
    const block = `${header}${body}`;
    parts.push(block);
    included.push(page.url);
    used += block.length + 2;
  }
  return { text: parts.join('\n\n'), included };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export async function crawlSiteWithTavily(baseUrl: string): Promise<ScrapeResult> {
  // 1. Map. A failed map is not fatal: we still have the homepage.
  let sitemap: string[] | undefined;
  try {
    sitemap = cleanSitemap(baseUrl, await mapWithTavily(baseUrl));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[site-crawl] Map failed for ${baseUrl} (${message}) - using the homepage only.`);
  }

  // 2. Select.
  const targets = selectPages(baseUrl, sitemap ?? [], config.siteCrawl.maxPages);

  // 3. Extract. If the whole batch fails, one more try with just the homepage.
  let pages: ExtractedPage[];
  try {
    pages = await extractWithTavily(targets);
  } catch (err) {
    if (targets.length <= 1) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[site-crawl] Batch extract failed for ${baseUrl} (${message}) - retrying homepage only.`);
    pages = await extractWithTavily([targets[0] as string]);
  }

  // Keep the order we chose (homepage first), whatever order Tavily answered in.
  const rank = new Map(
    targets.map((t, i) => [normKey(parse(t) ?? new URL(baseUrl)), i] as const)
  );
  pages.sort((a, b) => {
    const ra = rank.get(normKey(parse(a.url) ?? new URL(baseUrl))) ?? 999;
    const rb = rank.get(normKey(parse(b.url) ?? new URL(baseUrl))) ?? 999;
    return ra - rb;
  });

  // 4. Build.
  const { text, included } = buildScrapedText(pages);
  console.log(
    `[site-crawl] ${baseUrl}: ${sitemap ? sitemap.length : 'no'} URLs mapped, ` +
      `${targets.length} selected, ${included.length} extracted, ${text.length} chars.`
  );

  return {
    markdown: text,
    sourceUrl: pages[0]?.url ?? baseUrl,
    provider: 'tavily',
    ...(sitemap ? { sitemap } : {}),
    pagesIncluded: included,
  };
}
