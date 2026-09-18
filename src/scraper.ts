import { config } from './config.js';
import { scrapeWithFirecrawl, firecrawlLimiter } from './firecrawl.js';
import { scrapeWithTavily, tavilyLimiter } from './tavily.js';
import type { ScrapeProvider, ScrapeResult } from './types.js';

/** Bare domains in the database ("example.com") need a scheme. */
export function toUrl(domain: string): string {
  const trimmed = domain.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function runProvider(provider: ScrapeProvider, url: string): Promise<ScrapeResult> {
  return provider === 'tavily' ? scrapeWithTavily(url) : scrapeWithFirecrawl(url);
}

/**
 * Scrapes a domain with the configured primary provider, falling back to the
 * secondary one when the primary fails outright. Both providers return the
 * same { markdown, provider } shape so the rest of the pipeline never has to
 * care which one answered.
 */
export async function scrapeCompany(domain: string): Promise<ScrapeResult> {
  const url = toUrl(domain);
  const { primary, fallback } = config.scraper;

  try {
    return await runProvider(primary, url);
  } catch (err) {
    if (!fallback) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[scraper] ${primary} failed for ${domain} (${message}) - trying ${fallback}`);
    try {
      return await runProvider(fallback, url);
    } catch (fallbackErr) {
      const fallbackMessage =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`${primary}: ${message} | ${fallback}: ${fallbackMessage}`);
    }
  }
}

export function closeScrapers(): void {
  firecrawlLimiter.close();
  tavilyLimiter.close();
}

export function scraperStats(): string {
  const parts = [firecrawlLimiter, tavilyLimiter]
    .map((l) => l.stats())
    .map((s) => `${s.name} ${s.rpm}/${s.maxRpm}rpm`);
  return parts.join(', ');
}
