# company-categorizer-ts

Polls Postgres for companies that haven't been categorized yet, scrapes each
one (Firecrawl, or Tavily), classifies it with Claude, and writes the result
plus the exact token cost back into the row's JSONB `metadata`.

**Setup instructions live in [SETUP.md](./SETUP.md)** — local first, then
Cloud Run.

## What changed in this version

### 1. The work queue is the database, not the sheet

The pipeline no longer reads Google Sheets. It claims rows from
`public.company_metadata` where `metadata->>'checked'` is not true:

```sql
COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE
```

That is the crash-proof spelling of `(metadata->>'checked')::boolean IS NOT
TRUE` — a direct `::boolean` cast throws on any value that isn't boolean-ish,
which would abort a whole batch because of one odd row. NULL, missing, empty
and unrecognised all count as "not checked".

Claiming is a single atomic `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP
LOCKED)` that stamps `processing_started_at`. Two overlapping runs therefore
take different rows instead of duplicating paid work, and a row whose process
died becomes claimable again after `STALE_CLAIM_MS`.

Sheets write-back still exists behind `SHEET_WRITEBACK_ENABLED=true`, off by
default. All the `GOOGLE_*` variables are now optional.

### 2. Token usage is recorded per row

Every processed row gains, inside `metadata`:

`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` (all **cumulative** across attempts), plus
`last_run_usage` with the most recent call's breakdown, `checked_at` and
`scrape_provider`.

Writes are JSONB merges (`metadata || patch`), so `record_id`, `row_number`,
`created_by`, `last_interaction_with` and everything else survive untouched.
`migration.sql` adds a `company_token_usage` view that exposes the counters as
real numeric columns for querying.

### 3. Prompt caching

The ~1.6k-token system prompt is marked with `cache_control` and re-read at
~10% of base input price on every call after the first.

Two details that make the difference between caching working and silently
doing nothing:

- **The minimum cacheable prefix is 1,024 tokens** on Sonnet 4.x/5 (4,096 on
  Opus 4.5/4.6 and Haiku 4.5). The original prompt was ~830 tokens — *under*
  the line, so marking it would have cached nothing and returned no error. The
  prompt now carries a disambiguation section that both sharpens the
  classification and takes the cached prefix to ~1.6k tokens. The app warns
  once if a run comes back with zero cache reads and zero writes.
- **A cache entry is only readable once the first response has started.** With
  parallel workers, N first-calls would all miss and all pay a cache *write*.
  So each run fires one `max_tokens: 0` warm-up call first (zero output tokens
  billed), turning N writes into 1 write + N−1 reads.

`ANTHROPIC_CACHE_TTL=1h` keeps the cache alive between 15-minute cron runs;
`5m` is better if runs are more frequent than that.

### 4. Waiting replaced with rate limiting

The fixed `sleep(SCRAPE_DELAY_MS)` (20s) between every company is gone. A
fixed sleep has to be sized for the worst case, so you wait 20 seconds even
when the provider would take the next request immediately.

Instead each external service gets a token-bucket limiter
(`src/rateLimit.ts`) with a concurrency cap, and companies are processed by a
worker pool. Requests go out as fast as the configured rate allows and queue
only when the bucket is dry.

On a 429 the limiter halves its own rate for a cooldown and then walks it
back up (AIMD), and `src/retry.ts` retries with `Retry-After` honoured exactly
or full-jitter exponential backoff otherwise. A provider stricter than
configured self-corrects instead of being hammered every run.

Practical effect: a batch of 25 companies that took ~9 minutes of mostly
sleeping now takes roughly 1–2 minutes at `PIPELINE_CONCURRENCY=4`, without
tripping limits.

### 5. SSH tunnel kept, and hardened for the new concurrency

Reaching Postgres by SSHing into its host still works exactly as before
(`SSH_TUNNEL_ENABLED=true`, either `SSH_PRIVATE_KEY` or `SSH_PASSWORD`), but
the tunnel now carries `PIPELINE_CONCURRENCY + 1`
pooled connections across a run lasting minutes rather than one connection for
a few seconds. So: ssh keepalives (15s), a `readyTimeout` so a hanging
handshake fails fast instead of eating the Cloud Run task timeout, an error
handler so a dropped tunnel is logged rather than crashing the process, and
`DATABASE_POOL_MAX` to cap forwarded channels on a restrictive bastion. When
the tunnel does die the workers stop claiming new companies instead of paying
for scrapes and completions whose results can't be written back. Password
auth can optionally pin `SSH_HOST_FINGERPRINT` too: with no key pair, ssh2
accepts any host key by default, so without a pin the tunnel doesn't verify
it's really your server (the app logs a warning when this is the case).
See SETUP.md "SSH by password" for how to capture and pin it if you want that.

### 6. Tavily as an alternative scraper

`src/tavily.ts` wraps Tavily Extract behind the same interface as Firecrawl,
selected by `SCRAPE_PROVIDER` / `SCRAPE_FALLBACK_PROVIDER` and gated by
`TAVILY_ENABLED`. Both return the same `{ markdown, provider }` shape, so
nothing downstream knows which one answered; the row records which did.

Toggle it from `docker-compose.yml` without editing `.env` or any code:

```bash
docker compose up --build                                            # Firecrawl only
TAVILY_ENABLED=true TAVILY_API_KEY=tvly-... docker compose up --build  # + Tavily rescues failures
TAVILY_ENABLED=true SCRAPE_PROVIDER=tavily TAVILY_API_KEY=tvly-... docker compose up --build  # Tavily first
```

## Layout

| File | Role |
|---|---|
| `src/index.ts` | entrypoint, cron, graceful shutdown |
| `src/pipeline.ts` | claim → scrape → classify → write back, worker pool |
| `src/db.ts` | claim query, JSONB merge writes, token accumulation |
| `src/claudeAgent.ts` | prompt, prompt caching, cache pre-warm, usage extraction |
| `src/scraper.ts` | provider selection and fallback |
| `src/firecrawl.ts`, `src/tavily.ts` | the two scrapers |
| `src/rateLimit.ts` | token bucket + concurrency + AIMD backoff |
| `src/retry.ts` | retry with Retry-After and jittered backoff |
| `src/config.ts` | env parsing and startup validation |
| `schema.sql` / `migration.sql` | new database / existing database |

## Commands

```bash
npm install
npm run dev:once     # one batch from TypeScript source
npm run build && npm start   # compiled, self-scheduling
npm run typecheck
docker compose up --build    # the real image, against a local Postgres
```

## Note on the SDK

The pinned `@anthropic-ai/sdk` (^0.32.0) passes `cache_control` through and
reports the cache usage fields. If you want first-class types for the 1-hour
TTL, `npm i @anthropic-ai/sdk@latest`.
