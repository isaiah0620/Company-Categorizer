import axios, { type AxiosInstance } from 'axios';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import type {
  ScrapeResult,
  TavilyExtractResponse,
  TavilyMapResponse,
} from './types.js';

/**
 * Tavily as the single crawling provider.
 *
 *   POST /extract  { urls, extract_depth, format: "markdown" }
 *        -> { results: [{ url, raw_content }], failed_results: [{ url, error }] }
 *   POST /map      { url, max_depth, max_breadth, limit, allow_external }
 *        -> { base_url, results: [url, ...] }
 *
 * Selected with SCRAPE_PROVIDER=tavily (primary) or
 * SCRAPE_FALLBACK_PROVIDER=tavily. Set SCRAPE_FALLBACK_PROVIDER=none to make
 * it the ONLY provider (then FIRECRAWL_API_KEY isn't needed at all).
 *
 * The multi-page flow that combines the two endpoints lives in siteCrawl.ts.
 */
let client: AxiosInstance | null = null;

export const tavilyLimiter = new RateLimiter({
  name: 'tavily',
  rpm: config.tavily.rpm,
  concurrency: config.tavily.concurrency,
});

function getClient(): AxiosInstance {
  if (client) return client;
  client = axios.create({
    baseURL: config.tavily.baseUrl,
    headers: {
      Authorization: `Bearer ${config.tavily.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    },
    timeout: config.tavily.timeoutMs,
    validateStatus: () => true,
  });
  return client;
}

/**
 * One rate-limited, retried POST. Every Tavily call goes through here so a 429
 * on /map also slows /extract (they share the limiter), and 4xx errors carry
 * their status so retry.ts can tell "try again" from "give up".
 */
async function tavilyPost<T>(
  path: string,
  body: Record<string, unknown>,
  name: string,
  timeoutMs?: number
): Promise<T> {
  return tavilyLimiter.schedule(() =>
    withRetry(
      async () => {
        const res = await getClient().post(path, body, timeoutMs ? { timeout: timeoutMs } : {});
        if (res.status >= 400) {
          // Tavily wraps failures as { detail: { error } }; surface that text.
          const detail = (res.data as { detail?: { error?: string } } | undefined)?.detail?.error;
          const err = new Error(
            `Tavily ${path} responded HTTP ${res.status}${detail ? `: ${detail}` : ''}`
          ) as Error & { status: number; headers: unknown; body: unknown };
          err.status = res.status;
          err.headers = res.headers;
          err.body = res.data;
          throw err;
        }
        return res.data as T;
      },
      { name, retries: config.pipeline.maxRetries, limiter: tavilyLimiter }
    )
  );
}

/** Tavily Map: discovers URLs on the site without extracting content. */
export async function mapWithTavily(url: string): Promise<string[]> {
  const { mapDepth, mapBreadth, mapLimit, mapTimeoutSec } = config.siteCrawl;
  const body = await tavilyPost<TavilyMapResponse>(
    '/map',
    {
      url,
      max_depth: mapDepth,
      max_breadth: mapBreadth,
      limit: mapLimit,
      // Map defaults this to true, which would put other people's websites in
      // this company's sitemap.
      allow_external: false,
      timeout: mapTimeoutSec,
    },
    'tavily.map',
    (mapTimeoutSec + 15) * 1000
  );
  return Array.isArray(body?.results) ? body.results.filter((u) => typeof u === 'string') : [];
}

export interface ExtractedPage {
  url: string;
  markdown: string;
}

/**
 * Tavily Extract for up to 20 URLs in one request. Pages that fail or come
 * back empty are simply absent from the result - the caller decides whether
 * that's fatal.
 */
export async function extractWithTavily(urls: string[]): Promise<ExtractedPage[]> {
  if (urls.length === 0) return [];
  const body = await tavilyPost<TavilyExtractResponse>(
    '/extract',
    {
      urls: urls.slice(0, 20),
      extract_depth: config.tavily.extractDepth,
      format: 'markdown',
    },
    'tavily.extract'
  );

  const pages: ExtractedPage[] = [];
  for (const r of body?.results ?? []) {
    const markdown = r.raw_content ?? '';
    if (r.url && markdown.trim()) pages.push({ url: r.url, markdown });
  }

  if (pages.length === 0) {
    const failure = body?.failed_results?.[0]?.error;
    throw new Error(failure ?? 'Tavily returned no extractable content');
  }
  return pages;
}

/** Original single-page behaviour (used when SITE_CRAWL_ENABLED=false). */
export async function scrapeWithTavily(url: string): Promise<ScrapeResult> {
  const [first] = await extractWithTavily([url]);
  return {
    markdown: first?.markdown ?? '',
    sourceUrl: first?.url ?? url,
    provider: 'tavily',
  };
}
