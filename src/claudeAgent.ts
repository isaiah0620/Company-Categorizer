import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { withRetry } from './retry.js';
import type {
  CategorizationOutcome,
  CategorizationResult,
  CombinedCategorization,
  TokenUsage,
} from './types.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  // Retries are handled by withRetry() so a 429 also teaches the limiter.
  maxRetries: 0,
});

export const anthropicLimiter = new RateLimiter({
  name: 'anthropic',
  rpm: config.anthropic.rpm,
  concurrency: config.anthropic.concurrency,
});

/**
 * The system prompt is the only thing that repeats on every single call, so
 * it is the whole point of prompt caching here: mark it with cache_control
 * and every company after the first reads it at 10% of the input price
 * instead of paying full price to re-send the same ~1.3k tokens.
 *
 * IMPORTANT: prompt caching has a minimum cacheable prefix (1,024 tokens for
 * Sonnet 4.x / Sonnet 5; 4,096 for Opus 4.5/4.6 and Haiku 4.5). A shorter
 * prefix is silently NOT cached - no error, you just keep paying full price.
 * The original prompt was ~830 tokens, i.e. under the line, which is why the
 * disambiguation section below was added: it is genuinely useful guidance AND
 * it pushes the cached prefix comfortably over the 1,024-token minimum.
 *
 * Do not interpolate anything into this string (dates, domain names, counts).
 * Cache hits require a byte-identical prefix; a single varying character
 * turns every call into a cache write.
 */
const SYSTEM_PROMPT = `ROLE: Analyzing companies for an independent sponsor group's acquisition-target categorization system.

TASK: Using the company data provided below, assign ALL genuinely-applicable categories and, within each, ALL genuinely-applicable subcategories. Require clear, specific evidence from the content — not inference or a single adjacent keyword. A category may have more than one subcategory ONLY if the content gives distinct evidence for each; do not pad the list. Assigning 3+ categories overall is rare — double-check evidence before doing so.

CATEGORIES & SUBCATEGORIES
Independent Sponsors — no subcategories. Sources, acquires, and operates companies deal-by-deal without a committed fund; raises capital per-transaction.
Capital Source (provides debt/equity capital to businesses or deals):
 Family Office, Control PE Fund, Minority/Growth Equity Fund, Holding Company/Permanent Capital, Independent Sponsor, Search Fund, Self-Funded Searcher, HNW Investor, Institutional Investor, Fund of Funds, Endowment/Foundation, Banks, Direct Lender, Private Credit Fund, Mezzanine Fund, Junior Capital Fund, NAV/Fund Finance Lender, SBIC Fund, Structured Capital Provider, BDC
Intermediary (advises/facilitates deals, no principal risk):
 Business Broker, M&A Advisor, Sell-Side Investment Bank, Merchant Bank, Buy-Side Finder, Buy-Side Banker/Advisor, Deal Originator/Outsourced BD, Placement Agent, Debt Capital Markets Advisor/Debt Broker, Mortgage/Loan Broker, CPA/Tax Advisor, Transaction Attorney, Wealth Manager/RIA, Insurance Broker/Banker
Target — no subcategories. Operating Company: an operating business that could itself be an acquisition candidate, not primarily a financial/advisory firm.
Service Provider — no subcategories. QoE/Accounting Firms, FP&A/Outsourced CFO, Legal Counsel, Environmental & IT Diligence, Lender Counsel
Talent — no subcategories. Recruiter (incl. executive search / interim management)
Information & Infrastructure — no subcategories. Data Provider, CRM & Dealflow Platforms, Fund Administrators, Industry Associations/Conferences, Key Opinion Leader

RULES
1. Check Independent Sponsors first. If it's the company's primary activity, assign it (subcategories=[]), even alongside minor other activity. Add a 2nd category only if another activity is a genuinely separate, substantial business line — not an ancillary function supporting its own deal-sourcing.
2. Otherwise evaluate the 6 remaining categories against actual described activities. A company may span 2 categories; 3+ is rare.
3. For each assigned category, list ONLY the subcategories with clear, specific supporting evidence — never guess to fill the array, and never pick one just because it's "closest." Empty array [] is valid if none clearly fit.
4. Write a 1-2 sentence note per category citing the specific evidence that justified it and each subcategory chosen.

DISAMBIGUATION GUIDE (apply before finalizing)
Principal vs. advisor: the deciding question is who bears the risk. A firm that invests its own or its LPs' money into deals is a Capital Source. A firm paid a fee or a success commission to arrange, advise on, or place a transaction is an Intermediary — even when the site is full of deal logos and transaction tombstones. Tombstones alone are not evidence of principal investing; look for language about owning, holding, controlling, or deploying capital.
Independent Sponsor vs. Control PE Fund: an independent sponsor raises equity deal-by-deal and typically says so ("no committed fund", "deal-by-deal", "we raise capital per transaction", "fundless sponsor"). A firm describing a numbered, committed fund with a stated fund size, vintage, or LP base is a Capital Source / Control PE Fund instead.
Family Office vs. HNW Investor vs. Holding Company: a family office manages one or several families' wealth across asset classes. A holding company / permanent capital vehicle buys businesses to hold indefinitely with no stated exit horizon or fund life. Prefer Holding Company/Permanent Capital when the site stresses long-term ownership and operating involvement rather than wealth management.
Search Fund vs. Self-Funded Searcher: a search fund raises search capital from outside investors; a self-funded searcher explicitly acquires using personal capital plus SBA or seller financing.
Debt: a Direct Lender or Private Credit Fund lends its own balance-sheet or fund capital. A Mortgage/Loan Broker or Debt Capital Markets Advisor arranges third-party financing for a fee — that is Intermediary, not Capital Source.
Service Provider vs. Intermediary: an accounting, legal, or diligence firm that delivers a work product (a quality-of-earnings report, an opinion, an environmental assessment) is a Service Provider. The same professional firm becomes an Intermediary only when it markets sell-side or buy-side deal execution itself — CPA/Tax Advisor and Transaction Attorney subcategories exist for that deal-facing posture.
Target vs. everything else: assign Target when the company's revenue comes from selling a non-financial product or service — manufacturing, healthcare services, logistics, software sold to end users, trades and field services. A financial firm is not a Target merely because it could theoretically be bought.
Information & Infrastructure: use it for firms that sell data, software, administration, events, or audience to the deal community rather than doing deals. A CRM or dealflow platform sold to sponsors belongs here, not under Service Provider.
Thin or unusable content: when the scraped page is a parked domain, a login wall, a cookie notice, or otherwise gives no substantive description of what the company does, return an empty categories array rather than guessing from the domain name alone.
Naming: use the company's own name exactly as it presents itself on the page, without legal suffixes such as LLC, Inc., Ltd., or LP unless the company always writes them.

OUTPUT: Return ONLY this JSON — no markdown fences, no preamble:
{
 "companyName": string,
 "categories": [
   {"category": string, "subcategories": [string, ...], "note": string}
 ]
}`;

/** The cached system block. Built once so the object is literally identical. */
function systemParam(): Anthropic.MessageCreateParams['system'] {
  if (!config.anthropic.cacheEnabled) return SYSTEM_PROMPT;
  const block = {
    type: 'text' as const,
    text: SYSTEM_PROMPT,
    cache_control:
      config.anthropic.cacheTtl === '1h'
        ? { type: 'ephemeral' as const, ttl: '1h' }
        : { type: 'ephemeral' as const },
  };
  return [block] as unknown as Anthropic.MessageCreateParams['system'];
}

const SYSTEM = systemParam();

function readUsage(usage: unknown, model: string): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (key: string): number => {
    const value = u[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    input_tokens: n('input_tokens'),
    output_tokens: n('output_tokens'),
    cache_read_input_tokens: n('cache_read_input_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'),
    model,
    at: new Date().toISOString(),
  };
}

let cacheWarningShown = false;

function reportCache(usage: TokenUsage, domain: string): void {
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = usage;

  if (config.anthropic.cacheEnabled && read === 0 && written === 0 && !cacheWarningShown) {
    cacheWarningShown = true;
    console.warn(
      '[claude] Prompt cache reported 0 read and 0 written tokens. The cached prefix is ' +
        'probably below the model minimum (1,024 tokens for Sonnet, 4,096 for Opus 4.5/4.6 ' +
        'and Haiku 4.5). Check ANTHROPIC_MODEL, or lengthen the cached system prompt.'
    );
  }

  console.log(
    `[claude] ${domain}: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${read} cache_write=${written}`
  );
}

function extractJson(text: string): CategorizationResult {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as CategorizationResult;
}

function isCategorizationResult(value: unknown): value is CategorizationResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CategorizationResult>;
  return Array.isArray(candidate.categories);
}

/**
 * Writes the system prompt into the prompt cache before the workers fan out.
 *
 * Without this, N parallel first-calls all miss the cache and all pay a cache
 * WRITE (1.25x input price), because a cache entry only becomes readable once
 * the first response has started. One cheap warm-up call (max_tokens: 0,
 * zero output tokens billed) turns those N writes into 1 write + N-1 reads.
 */
export async function prewarmPromptCache(): Promise<void> {
  if (!config.anthropic.cacheEnabled || !config.anthropic.prewarmCache) return;

  const send = (maxTokens: number): Promise<Anthropic.Message> =>
    anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'warmup' }],
    });

  try {
    const message = await anthropicLimiter.schedule(() =>
      withRetry(
        async () => {
          try {
            return await send(0);
          } catch (err) {
            // Older API versions reject max_tokens: 0; 1 token is a fine
            // substitute and still writes the cache.
            const status = (err as { status?: number })?.status;
            if (status === 400) return await send(1);
            throw err;
          }
        },
        { name: 'claude.prewarm', retries: 2, limiter: anthropicLimiter }
      )
    );
    const usage = readUsage(message.usage, config.anthropic.model);
    console.log(
      `[claude] Prompt cache warmed (written=${usage.cache_creation_input_tokens}, ` +
        `read=${usage.cache_read_input_tokens}).`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claude] Cache pre-warm skipped: ${message}`);
  }
}

/**
 * Calls Claude to categorize a single company from its scraped markdown, and
 * returns the parsed result together with the exact token counters the call
 * consumed so they can be written into the row's JSONB metadata.
 */
export async function categorizeCompany(
  companyMarkdown: string,
  domain: string
): Promise<CategorizationOutcome> {
  const message = await anthropicLimiter.schedule(() =>
    withRetry(
      () =>
        anthropic.messages.create({
          model: config.anthropic.model,
          max_tokens: config.anthropic.maxTokens,
          system: SYSTEM,
          messages: [{ role: 'user', content: `COMPANY DATA:\n${companyMarkdown}` }],
        }),
      { name: 'claude.messages', retries: config.pipeline.maxRetries, limiter: anthropicLimiter }
    )
  );

  const usage = readUsage(message.usage, config.anthropic.model);
  reportCache(usage, domain);

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) {
    const err = new Error('Claude response contained no text block') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  let parsed: CategorizationResult;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      `Failed to parse Claude JSON output: ${reason}\nRaw: ${textBlock.text.slice(0, 500)}`
    ) as Error & { usage: TokenUsage };
    wrapped.usage = usage;
    throw wrapped;
  }

  if (!isCategorizationResult(parsed)) {
    const err = new Error('Claude output missing "categories" array') as Error & {
      usage: TokenUsage;
    };
    err.usage = usage;
    throw err;
  }

  return { result: parsed, usage };
}

/** Collapses the categories array into flat category / sub_category / note. */
export function combineCategories({
  companyName,
  categories,
}: CategorizationResult): CombinedCategorization {
  const uniqueCategories = [...new Set(categories.map((c) => c.category))];
  const combinedCategory = uniqueCategories.join(', ');
  const combinedSubcategory = categories.flatMap((c) => c.subcategories ?? []).join(', ');
  const combinedNote = categories
    .map(
      (c) => `${c.category} (${(c.subcategories ?? []).join('/') || 'no subcategory'}): ${c.note}`
    )
    .join('\n\n');

  return { companyName, combinedCategory, combinedSubcategory, combinedNote };
}

export function closeAnthropic(): void {
  anthropicLimiter.close();
}
