import { config } from './config.js';
import { getRows, updateRowByDomain } from './googleSheets.js';
import { scrapeDomain } from './firecrawl.js';
import { stripImages } from './cleanMarkdown.js';
import { categorizeCompany, combineCategories } from './claudeAgent.js';
import { upsertCompanyMetadata } from './db.js';
import type { SheetRow } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Port of "If8" + "If6": keep rows that are not yet Checked, and that have
 * a Domain, no existing Note, and no existing Errors (i.e. genuinely unprocessed).
 */
function selectUnprocessedRows(rows: SheetRow[]): SheetRow[] {
  return rows.filter((row) => {
    const checked = String(row.Checked ?? '').trim();
    const note = String(row.Note ?? '').trim();
    const errors = String(row.Errors ?? '').trim();
    const domain = String(row.Domains ?? '').trim();
    return checked === '' && note === '' && errors === '' && domain !== '';
  });
}

async function processCompany(row: SheetRow): Promise<void> {
  const domain = row.Domains;
  if (!domain) return;

  console.log(`[pipeline] Processing ${domain}`);

  let scrapeResult;
  try {
    scrapeResult = await scrapeDomain(domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Scrape failed for ${domain}:`, message);
    await updateRowByDomain(domain, { Errors: message });
    return;
  }

  const statusCode = scrapeResult?.data?.metadata?.statusCode;
  const scrapeError = scrapeResult?.data?.metadata?.error;

  if (statusCode !== undefined && statusCode >= 400) {
    console.warn(`[pipeline] ${domain} returned status ${statusCode}`);
    await updateRowByDomain(domain, { Errors: scrapeError ?? `HTTP ${statusCode}` });
    return;
  }

  const cleanedMarkdown = stripImages(scrapeResult?.data?.markdown ?? '');
  if (!cleanedMarkdown) {
    await updateRowByDomain(domain, { Errors: 'No scrapable content returned' });
    return;
  }

  let categorization;
  try {
    categorization = await categorizeCompany(cleanedMarkdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Categorization failed for ${domain}:`, message);
    await updateRowByDomain(domain, { Errors: message });
    return;
  }

  const combined = combineCategories(categorization);

  await updateRowByDomain(domain, {
    Category: combined.combinedCategory,
    'Sub Category': combined.combinedSubcategory,
    Note: combined.combinedNote,
    Checked: 'True',
  });

  // Give the sheet update a moment to land before we read it back / upsert.
  await sleep(config.pipeline.betweenCompanyDelayMs);

  await upsertCompanyMetadata(domain, {
    Domains: domain,
    companyName: combined.companyName,
    Category: combined.combinedCategory,
    'Sub Category': combined.combinedSubcategory,
    Note: combined.combinedNote,
    Checked: 'True',
  });

  console.log(`[pipeline] Done: ${domain} -> ${combined.combinedCategory}`);
}

export async function runPipeline(): Promise<void> {
  console.log('[pipeline] Fetching rows from Google Sheets...');
  const rows = await getRows();

  const unprocessed = selectUnprocessedRows(rows);
  const batch = unprocessed.slice(0, config.pipeline.batchSize);

  console.log(
    `[pipeline] ${unprocessed.length} unprocessed row(s) found, processing ${batch.length} this run.`
  );

  for (const row of batch) {
    await processCompany(row);
    // Mirrors the "Wait" node between Firecrawl scrapes to respect rate limits.
    await sleep(config.pipeline.scrapeDelayMs);
  }

  console.log('[pipeline] Run complete.');
}
