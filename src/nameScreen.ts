import type Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getAnthropicClient, anthropicLimiter, readUsage, buildCachedSystem, prewarmSystem } from './claudeAgent.js';
import { withRetry } from './retry.js';
import { NAME_SCREEN_SYSTEM_PROMPT } from './prompts.js';
import { cleanNameScreenInput, parseNameScreenResult } from './nameScreenParsing.js';
import type { NameScreenOutcome, NameScreenResult, TokenUsage } from './types.js';

/** The cached system block, built once so the object is literally identical on every call. */
const SCREEN_SYSTEM = buildCachedSystem(NAME_SCREEN_SYSTEM_PROMPT);

/**
 * Warms the name-screen prompt into the cache. Call this once before workers
 * fan out, same as prewarmPromptCache() for the categorizer - a no-op when
 * caching/prewarming is off, or when the name screen itself is disabled.
 */
export async function prewarmNameScreenCache(): Promise<void> {
  if (!config.nameScreen.enabled) return;
  await prewarmSystem(SCREEN_SYSTEM, 'nameScreen');
}

function withUsage(message: string, usage: TokenUsage): Error {
  const err = new Error(message) as Error & { usage: TokenUsage };
  err.usage = usage;
  return err;
}

/**
 * Asks Claude whether a company is clearly a Target from its name and domain
 * alone. Throws on API failure or an unparseable reply (with `.usage` attached
 * when tokens were spent) - the caller treats that as "unsure" and carries on.
 */
export async function screenCompanyName(name: string, domain: string): Promise<NameScreenOutcome> {
  const message = await anthropicLimiter.schedule(() =>
    withRetry(
      () =>
        getAnthropicClient().messages.create({
          model: config.anthropic.model,
          max_tokens: config.nameScreen.maxTokens,
          system: SCREEN_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `COMPANY NAME: ${cleanNameScreenInput(name)}\nDOMAIN: ${cleanNameScreenInput(domain)}`,
            },
          ],
        }),
      { name: 'claude.nameScreen', retries: config.pipeline.maxRetries, limiter: anthropicLimiter }
    )
  );

  const usage = readUsage(message.usage, config.anthropic.model);

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) throw withUsage('Name screen response contained no text block', usage);

  let result: NameScreenResult;
  try {
    result = parseNameScreenResult(textBlock.text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw withUsage(
      `Failed to parse name screen output: ${reason}\nRaw: ${textBlock.text.slice(0, 300)}`,
      usage
    );
  }

  return {
    result,
    usage,
    isConfidentTarget:
      result.verdict === 'target' && result.confidence >= config.nameScreen.minConfidence,
  };
}
