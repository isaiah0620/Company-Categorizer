/**
 * Input cleaning and output parsing for the name/domain pre-screen, shared
 * by every LLM provider. Pulled out of nameScreen.ts so a second provider
 * doesn't need to duplicate (or drift from) the same parsing rules.
 */
import type { NameScreenResult } from './types.js';

/** Name/domain come from the database; keep them to one line and bounded. */
export function cleanNameScreenInput(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
}

export function parseNameScreenResult(text: string): NameScreenResult {
  // Tolerate fences or a stray sentence around the object.
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object found');

  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const verdict = raw.verdict;
  if (verdict !== 'target' && verdict !== 'not_target' && verdict !== 'unsure') {
    throw new Error(`invalid verdict ${JSON.stringify(verdict)}`);
  }

  // Missing or non-numeric confidence counts as zero, so it can never
  // accidentally clear the threshold.
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 500) : '';

  return { verdict, confidence, reason };
}
