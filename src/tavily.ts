import axios, { type AxiosInstance } from 'axios';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import type { ScrapeResult, TavilyExtractResponse } from './types.js';

/**
 * Tavily Extract as a drop-in alternative to Firecrawl.
 *
 * POST https://api.tavily.com/extract
 *   { urls, extract_depth: "basic" | "advanced", format: "markdown" }
 *   -> { results: [{ url, raw_content }], failed_results: [{ url, error }] }
 *
 * Switched on with TAVILY_ENABLED=true; selected with SCRAPE_PROVIDER=tavily
 * (primary) or SCRAPE_FALLBACK_PROVIDER=tavily (only when Firecrawl fails).
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

export async function scrapeWithTavily(url: string): Promise<ScrapeResult> {
  const body = await tavilyLimiter.schedule(() =>
    withRetry(
      async () => {
        const res = await getClient().post('/extract', {
          urls: [url],
          extract_depth: config.tavily.extractDepth,
          format: 'markdown',
        });
        if (res.status >= 400) {
          const err = new Error(`Tavily responded HTTP ${res.status}`) as Error & {
            status: number;
            headers: unknown;
            body: unknown;
          };
          err.status = res.status;
          err.headers = res.headers;
          err.body = res.data;
          throw err;
        }
        return res.data as TavilyExtractResponse;
      },
      { name: 'tavily.extract', retries: config.pipeline.maxRetries, limiter: tavilyLimiter }
    )
  );

  const first = body?.results?.[0];
  const markdown = first?.raw_content ?? '';

  if (!markdown.trim()) {
    const failure = body?.failed_results?.[0]?.error;
    throw new Error(failure ?? 'Tavily returned no extractable content');
  }

  return { markdown, sourceUrl: first?.url ?? url, provider: 'tavily' };
}
