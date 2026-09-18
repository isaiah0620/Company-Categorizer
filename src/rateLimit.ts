/**
 * A token-bucket rate limiter with a concurrency cap and AIMD backoff.
 *
 * This replaces the old fixed `sleep(SCRAPE_DELAY_MS)` between companies.
 * A fixed sleep has to be set to the worst case to avoid 429s, which means
 * you wait 20s even when the provider would happily take the next request
 * immediately. A token bucket instead lets requests through as fast as the
 * provider's published limit allows, and only queues when the bucket is dry.
 *
 * On a 429 the limiter halves its own rate for a cooldown window and then
 * walks it back up (additive increase / multiplicative decrease), so a
 * provider that is stricter than configured self-corrects instead of
 * hammering the ceiling every run.
 */
export interface RateLimiterOptions {
  name: string;
  /** Sustained requests per minute. */
  rpm: number;
  /** Max simultaneous in-flight requests. */
  concurrency: number;
  /** How many requests may burst at once. Defaults to the concurrency cap. */
  burst?: number;
  /** Floor the adaptive backoff will not go below. Defaults to rpm/8. */
  minRpm?: number;
  /** How often the limiter tries to recover rate after a 429. */
  recoveryIntervalMs?: number;
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class RateLimiter {
  readonly name: string;

  private readonly maxRpm: number;
  private readonly minRpm: number;
  private readonly concurrency: number;
  private readonly burst: number;
  private readonly recoveryIntervalMs: number;

  private currentRpm: number;
  private tokens: number;
  private lastRefill: number;
  private active = 0;
  private queue: QueueEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRecovery = Date.now();
  private closed = false;

  constructor(options: RateLimiterOptions) {
    this.name = options.name;
    this.maxRpm = Math.max(1, options.rpm);
    this.minRpm = Math.max(1, options.minRpm ?? Math.ceil(options.rpm / 8));
    this.concurrency = Math.max(1, options.concurrency);
    this.burst = Math.max(1, options.burst ?? this.concurrency);
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;

    this.currentRpm = this.maxRpm;
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  /** Queues `fn` and runs it as soon as a token and a slot are free. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  /**
   * Called when a provider answers 429 (or tells us to back off). Halves the
   * effective rate and, when the provider sent Retry-After, drains the bucket
   * for that long so nothing else goes out in the meantime.
   */
  penalize(retryAfterMs?: number): void {
    const before = this.currentRpm;
    this.currentRpm = Math.max(this.minRpm, Math.floor(this.currentRpm / 2));
    this.lastRecovery = Date.now();
    if (before !== this.currentRpm) {
      console.warn(
        `[ratelimit:${this.name}] 429 received - reducing rate ${before} -> ${this.currentRpm} rpm`
      );
    }
    this.tokens = 0;
    if (retryAfterMs && retryAfterMs > 0) {
      // Push the refill clock forward so the bucket stays empty that long.
      this.lastRefill = Date.now() + retryAfterMs;
    }
  }

  /** Current effective rate, for logging. */
  stats(): { name: string; rpm: number; maxRpm: number; queued: number; active: number } {
    return {
      name: this.name,
      rpm: this.currentRpm,
      maxRpm: this.maxRpm,
      queued: this.queue.length,
      active: this.active,
    };
  }

  /** Rejects anything still queued. Called on shutdown. */
  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.queue;
    this.queue = [];
    for (const entry of pending) {
      entry.reject(new Error(`[ratelimit:${this.name}] limiter closed`));
    }
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`[ratelimit:${this.name}] limiter closed`));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.pump();
    });
  }

  private refill(): void {
    const now = Date.now();
    if (now <= this.lastRefill) return;

    // Additive recovery back towards the configured rate after a penalty.
    if (this.currentRpm < this.maxRpm && now - this.lastRecovery >= this.recoveryIntervalMs) {
      this.currentRpm = Math.min(this.maxRpm, Math.ceil(this.currentRpm * 1.5));
      this.lastRecovery = now;
      console.log(`[ratelimit:${this.name}] recovering rate -> ${this.currentRpm} rpm`);
    }

    const elapsed = now - this.lastRefill;
    const gained = (elapsed * this.currentRpm) / 60_000;
    if (gained <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + gained);
    this.lastRefill = now;
  }

  private pump(): void {
    if (this.closed) return;
    this.refill();

    while (this.queue.length > 0 && this.active < this.concurrency && this.tokens >= 1) {
      const next = this.queue.shift();
      if (!next) break;
      this.tokens -= 1;
      this.active += 1;
      next.resolve();
    }

    if (this.queue.length === 0 || this.timer) return;

    // Nothing runnable right now: wake up when the next token is due (or
    // sooner, if a slot frees up first - that path calls pump() directly).
    const msPerToken = 60_000 / this.currentRpm;
    const deficit = Math.max(0, 1 - this.tokens);
    const waitForToken = Math.ceil(deficit * msPerToken);
    const waitForClock = Math.max(0, this.lastRefill - Date.now());
    const wait = Math.max(25, waitForToken + waitForClock);

    // NOTE: deliberately NOT unref()'d. If this timer were unref'd and every
    // worker happened to be waiting on a token with no request in flight, the
    // event loop would have nothing left to keep it alive and the process
    // would exit mid-batch. close() clears it, and it only exists while the
    // queue is non-empty.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, wait);
  }
}
