import type { RateLimiter } from './rateLimit.js';

/**
 * Retry helper shared by every outbound call.
 *
 * Rules:
 *  - 429 and 5xx and transient network errors are retried.
 *  - A `Retry-After` header is obeyed exactly (seconds or HTTP-date).
 *  - Otherwise: exponential backoff with full jitter, so a batch of parallel
 *    workers that all get throttled at once don't retry in lockstep.
 *  - 4xx other than 429/408 fail immediately - retrying a 401 or a 400 just
 *    burns time.
 */
export interface RetryOptions {
  name: string;
  retries: number;
  /** Limiter to notify on a 429 so it can slow the whole pipeline down. */
  limiter?: RateLimiter;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNREFUSED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** Minimal shape of a fetch-style Headers object, declared locally so this
 *  file doesn't depend on DOM or undici lib types being present. */
interface HeaderBag {
  get?(name: string): string | null;
}

interface ErrorLike {
  status?: number;
  code?: string;
  message?: string;
  response?: { status?: number; headers?: Record<string, unknown> };
  headers?: Record<string, unknown> | HeaderBag;
}

export function statusOf(err: unknown): number | undefined {
  const e = err as ErrorLike | null;
  if (!e || typeof e !== 'object') return undefined;
  return e.response?.status ?? e.status;
}

function headerValue(err: unknown, key: string): string | undefined {
  const e = err as ErrorLike | null;
  if (!e || typeof e !== 'object') return undefined;

  const fromResponse = e.response?.headers;
  if (fromResponse && typeof fromResponse === 'object') {
    const value = (fromResponse as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }

  const own = e.headers;
  if (own) {
    const bag = own as HeaderBag;
    if (typeof bag.get === 'function') {
      const value = bag.get(key);
      if (value) return value;
    } else if (typeof own === 'object') {
      const value = (own as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

/** Parses Retry-After, which may be seconds or an HTTP date. */
export function retryAfterMs(err: unknown): number | undefined {
  const raw = headerValue(err, 'retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);

  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) {
    return status === 429 || status === 408 || status === 409 || status >= 500;
  }
  const code = (err as ErrorLike | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 500;
  const cap = options.maxDelayMs ?? 60_000;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const retryable = isRetryable(err);

      if (status === 429) {
        options.limiter?.penalize(retryAfterMs(err));
      }

      if (!retryable || attempt >= options.retries) throw err;

      // Retry-After wins; otherwise exponential backoff with full jitter.
      const serverDelay = retryAfterMs(err);
      const backoff = Math.min(cap, base * 2 ** attempt);
      const wait = serverDelay ?? Math.round(Math.random() * backoff);

      attempt += 1;
      console.warn(
        `[retry:${options.name}] attempt ${attempt}/${options.retries} after ` +
          `${status ? `HTTP ${status}` : (err as ErrorLike)?.code ?? 'error'} - waiting ${wait}ms`
      );
      await sleep(Math.max(wait, 50));
    }
  }
}
