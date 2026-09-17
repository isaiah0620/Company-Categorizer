import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { CategorizationResult, CombinedCategorization } from './types.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Same taxonomy + rules as the original n8n "AI Agent2" prompt.
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

OUTPUT: Return ONLY this JSON — no markdown fences, no preamble:
{
 "companyName": string,
 "categories": [
   {"category": string, "subcategories": [string, ...], "note": string}
 ]
}`;

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
 * Calls Claude to categorize a single company from its scraped markdown.
 * Returns { companyName, categories: [{ category, subcategories, note }] }
 */
export async function categorizeCompany(companyMarkdown: string): Promise<CategorizationResult> {
  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `COMPANY DATA:\n${companyMarkdown}`,
      },
    ],
  });

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) {
    throw new Error('Claude response contained no text block');
  }

  let parsed: CategorizationResult;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Claude JSON output: ${reason}\nRaw: ${textBlock.text}`);
  }

  if (!isCategorizationResult(parsed)) {
    throw new Error('Claude output missing "categories" array');
  }

  return parsed;
}

/**
 * Port of the "Code in JavaScript1" node: collapses the categories array
 * into the flat Category / Sub Category / Note columns the sheet expects.
 */
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
