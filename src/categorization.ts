/**
 * Parsing and shaping logic for the categorizer's output, shared by every
 * LLM provider. Pulled out of claudeAgent.ts so a second provider doesn't
 * need to duplicate (or drift from) the same parsing rules.
 */
import type { CategorizationResult, CombinedCategorization } from './types.js';

export function extractCategorizationJson(text: string): CategorizationResult {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as CategorizationResult;
}

export function isCategorizationResult(value: unknown): value is CategorizationResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CategorizationResult>;
  return Array.isArray(candidate.categories);
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
