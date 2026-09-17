import axios, { type AxiosInstance } from 'axios';
import { config } from './config.js';
import type { FirecrawlMapResponse, FirecrawlScrapeResponse } from './types.js';

const client: AxiosInstance = axios.create({
  baseURL: config.firecrawl.baseUrl,
  headers: {
    Authorization: `Bearer ${config.firecrawl.apiKey}`,
    'Content-Type': 'application/json',
  },
  // Firecrawl scrapes can take a while; don't let axios time out too early.
  timeout: 120000,
});

/**
 * Equivalent of the n8n "/map" node: discovers URLs on the domain.
 * Currently informational only (mirrors the original workflow, where the
 * map result isn't consumed downstream) but kept here in case you want to
 * expand into multi-page scraping later.
 */
export async function mapDomain(url: string): Promise<FirecrawlMapResponse> {
  const res = await client.post<FirecrawlMapResponse>('/map', { url });
  return res.data;
}

/**
 * Equivalent of the n8n "/scrape" node: scrapes a single URL and returns
 * Firecrawl's { data: { markdown, metadata: { statusCode, ... } } } shape.
 */
export async function scrapeDomain(url: string): Promise<FirecrawlScrapeResponse> {
  const res = await client.post<FirecrawlScrapeResponse>('/scrape', {
    url,
    formats: ['markdown'],
  });
  return res.data;
}
