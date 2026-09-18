import axios, { type AxiosInstance } from 'axios';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import type {
  FirecrawlMapResponse,
  FirecrawlScrapeResponse,
  ScrapeResult,
} from './types.js';

let client: AxiosInstance | null = null;

export const firecrawlLimiter = new RateLimiter({
  name: 'firecrawl',
  rpm: config.firecrawl.rpm,
  concurrency: config.firecrawl.concurrency,
});

function getClient(): AxiosInstance {
  if (client) return client;
  client = axios.create({
    baseURL: config.firecrawl.baseUrl,
    headers: {
      Authorization: `Bearer ${config.firecrawl.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    },
    timeout: config.firecrawl.timeoutMs,
    // Let us inspect 4xx/5xx ourselves instead of axios throwing before the
    // retry layer can read Retry-After.
    validateStatus: () => true,
  });
  return client;
}

/** Turns an axios result into either data or a thrown error carrying status. */
function unwrap<T>(res: { status: number; data: unknown; headers: unknown }): T {
  if (res.status >= 400) {
    const err = new Error(`Firecrawl responded HTTP ${res.status}`) as Error & {
      status: number;
      headers: unknown;
      body: unknown;
    };
    err.status = res.status;
    err.headers = res.headers;
    err.body = res.data;
    throw err;
  }
  return res.data as T;
}

/** Discovers URLs on a domain. Not used by the default pipeline. */
export async function mapDomain(url: string): Promise<FirecrawlMapResponse> {
  return firecrawlLimiter.schedule(() =>
    withRetry(
      async () => {
        const res = await getClient().post('/map', { url });
        return unwrap<FirecrawlMapResponse>(res);
      },
      { name: 'firecrawl.map', retries: config.pipeline.maxRetries, limiter: firecrawlLimiter }
    )
  );
}

export async function scrapeWithFirecrawl(url: string): Promise<ScrapeResult> {
  const body = await firecrawlLimiter.schedule(() =>
    withRetry(
      async () => {
        const res = await getClient().post('/scrape', { url, formats: ['markdown'] });
        return unwrap<FirecrawlScrapeResponse>(res);
      },
      { name: 'firecrawl.scrape', retries: config.pipeline.maxRetries, limiter: firecrawlLimiter }
    )
  );

  const statusCode = body?.data?.metadata?.statusCode;
  const pageError = body?.data?.metadata?.error;

  if (statusCode !== undefined && statusCode >= 400) {
    throw new Error(pageError ?? `Target site returned HTTP ${statusCode}`);
  }

  const markdown = body?.data?.markdown ?? '';
  if (!markdown.trim()) {
    throw new Error('Firecrawl returned no scrapable content');
  }

  return {
    markdown,
    statusCode,
    sourceUrl: body?.data?.metadata?.sourceURL,
    provider: 'firecrawl',
  };
}
