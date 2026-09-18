import { config } from './config.js';
import {
  claimPendingCompanies,
  countPending,
  finishCompany,
  isTransportHealthy,
  tokenTotals,
} from './db.js';
import { scrapeCompany, scraperStats } from './scraper.js';
import { stripImages } from './cleanMarkdown.js';
import { categorizeCompany, combineCategories, prewarmPromptCache } from './claudeAgent.js';
import { EMPTY_USAGE } from './types.js';
import type { CompanyMetadata, PendingCompany, TokenUsage } from './types.js';

interface RunTotals {
  processed: number;
  failed: number;
  usage: TokenUsage;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** Pulls the usage counters off an error thrown after a billable API call. */
function usageFromError(err: unknown): TokenUsage | undefined {
  const maybe = (err as { usage?: TokenUsage } | null)?.usage;
  return maybe && typeof maybe.input_tokens === 'number' ? maybe : undefined;
}

async function recordFailure(company: PendingCompany, message: string, usage?: TokenUsage) {
  const patch: Partial<CompanyMetadata> = {
    errors: message.slice(0, 2000),
    checked: false,
    checked_at: new Date().toISOString(),
  };
  await finishCompany(company.id, patch, usage);
}

async function processCompany(company: PendingCompany): Promise<TokenUsage> {
  const { domain } = company;
  console.log(`[pipeline] Processing ${domain}`);

  // --- scrape ---
  let scraped;
  try {
    scraped = await scrapeCompany(domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Scrape failed for ${domain}: ${message}`);
    await recordFailure(company, message);
    throw new Error(message);
  }

  const cleanedMarkdown = stripImages(scraped.markdown);
  if (!cleanedMarkdown) {
    const message = 'No scrapable content returned';
    await recordFailure(company, message);
    throw new Error(message);
  }

  // --- categorize ---
  let outcome;
  try {
    outcome = await categorizeCompany(cleanedMarkdown, domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Categorization failed for ${domain}: ${message}`);
    // Even a failed parse burned tokens - still bill them to the row.
    await recordFailure(company, message, usageFromError(err));
    throw new Error(message);
  }

  const combined = combineCategories(outcome.result);

  // --- write result + token usage back into the JSONB ---
  const patch: Partial<CompanyMetadata> = {
    name: combined.companyName || company.metadata.name || null,
    domain: company.metadata.domain ?? domain,
    category: combined.combinedCategory || null,
    sub_category: combined.combinedSubcategory || null,
    note: combined.combinedNote || null,
    errors: null,
    checked: true,
    checked_at: new Date().toISOString(),
    scrape_provider: scraped.provider,
  };

  await finishCompany(company.id, patch, outcome.usage);

  if (config.pipeline.sheetWriteback) {
    try {
      const { updateRowByDomain } = await import('./googleSheets.js');
      await updateRowByDomain(domain, {
        Category: combined.combinedCategory,
        'Sub Category': combined.combinedSubcategory,
        Note: combined.combinedNote,
        Checked: 'True',
      });
    } catch (err) {
      // Sheet mirroring is best-effort: the database is the source of truth.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline] Sheet write-back failed for ${domain}: ${message}`);
    }
  }

  console.log(
    `[pipeline] Done: ${domain} -> ${combined.combinedCategory || '(no category)'} ` +
      `[${scraped.provider}]`
  );
  return outcome.usage;
}

/**
 * Fixed-size worker pool. Workers pull from a shared cursor, so a slow domain
 * never blocks the others - which is the real reason the old fixed sleeps
 * could go: throughput is now bounded by the per-provider rate limiters, not
 * by a worst-case delay applied to every company equally.
 */
async function runWorkers(companies: PendingCompany[], totals: RunTotals): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(config.pipeline.concurrency, companies.length);

  const worker = async (id: number): Promise<void> => {
    for (;;) {
      // A dead SSH tunnel means no result can be written for anything we do
      // from here on, so stop spending scrape/model credits. The claimed rows
      // are reclaimed automatically once STALE_CLAIM_MS passes.
      if (!isTransportHealthy()) {
        console.error('[pipeline] Database transport is down - stopping this run early.');
        return;
      }

      const index = cursor;
      cursor += 1;
      if (index >= companies.length) return;
      const company = companies[index];
      if (!company) return;

      try {
        const usage = await processCompany(company);
        totals.processed += 1;
        totals.usage = addUsage(totals.usage, usage);
      } catch {
        // Already logged and already written to the row's `errors` field.
        totals.failed += 1;
      }
      void id;
    }
  };

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
}

export async function runPipeline(): Promise<void> {
  const startedAt = Date.now();
  console.log('[pipeline] Claiming unchecked rows from the database...');

  const pending = await countPending();
  const batch = await claimPendingCompanies(config.pipeline.batchSize);

  console.log(
    `[pipeline] ${pending} unchecked row(s) in table, claimed ${batch.length} this run ` +
      `(concurrency ${config.pipeline.concurrency}).`
  );

  if (batch.length === 0) {
    console.log('[pipeline] Nothing to do.');
    return;
  }

  // Write the system prompt into the cache once before workers fan out, so
  // the parallel calls read it instead of each paying for a cache write.
  await prewarmPromptCache();

  const totals: RunTotals = { processed: 0, failed: 0, usage: { ...EMPTY_USAGE } };
  await runWorkers(batch, totals);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const { usage } = totals;
  const billableInput = usage.input_tokens + usage.cache_creation_input_tokens;
  const cacheRatio =
    usage.cache_read_input_tokens + billableInput > 0
      ? (
          (usage.cache_read_input_tokens / (usage.cache_read_input_tokens + billableInput)) *
          100
        ).toFixed(1)
      : '0.0';

  console.log(
    `[pipeline] Run complete in ${seconds}s: ${totals.processed} ok, ${totals.failed} failed. ` +
      `Tokens this run: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens} cache_write=${usage.cache_creation_input_tokens} ` +
      `(${cacheRatio}% of input served from cache). Limiters: ${scraperStats()}.`
  );

  try {
    const totalsAllTime = await tokenTotals();
    console.log(
      `[pipeline] Table totals: in=${totalsAllTime.input} out=${totalsAllTime.output} ` +
        `cache_read=${totalsAllTime.cacheRead} cache_write=${totalsAllTime.cacheWrite}`
    );
  } catch {
    /* totals are informational only */
  }
}
