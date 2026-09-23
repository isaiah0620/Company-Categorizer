# company-categorizer-ts

Polls Postgres for companies that haven't been categorized yet, first checks
each one's name and domain with an LLM (a clear operating business is stored
as a Target immediately), otherwise scrapes it (Firecrawl, or Tavily),
classifies it with an LLM, and writes the result plus the exact token cost
back into the row's JSONB `metadata`.

**Setup instructions live in [SETUP.md](./SETUP.md)** — local first, then
Cloud Run.

## Choosing a provider: Anthropic or OpenAI

Set `LLM_PROVIDER=anthropic` (the default) or `LLM_PROVIDER=openai` in your
`.env`. Only the selected provider's API key is required at startup —
`validateConfig()` fails fast with a clear message if it's missing, and
doesn't require the other provider's key at all.

```bash
# Anthropic (default)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

Everything provider-agnostic — the name screen's threshold, retry counts,
pipeline concurrency, the categorizer's rules — stays exactly the same either
way; only which API actually gets called changes. `src/llm.ts` is the single
switch point: `pipeline.ts` and `index.ts` call `categorizeCompany()`,
`screenCompanyName()`, `prewarmCaches()` and `closeLlm()` from there without
knowing which provider is behind them.

Both providers cache the (identical) system prompts in `src/prompts.ts`
automatically once a run's prefix clears their minimum cacheable length —
1,024–4,096 tokens depending on the specific Anthropic model, a flat 1,024
tokens on OpenAI. See the "Prompt caching" section below for the Anthropic
specifics; on OpenAI there's no TTL or cache_control to configure, it just
works once the threshold is cleared.

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

### 7. Name + domain pre-screen

Before any scraping, `src/nameScreen.ts` asks Claude one narrow question using
only the company's **name and domain**: is this clearly an operating business
(a Target)?

| Screen says | What happens |
|---|---|
| `target`, confidence ≥ `NAME_SCREEN_MIN_CONFIDENCE` (0.9) | Stored as `category = "Target"` straight away. **No Firecrawl/Tavily call, no categorization call.** |
| `target` below the threshold, `not_target`, or `unsure` | Continues down the original scrape → categorize path, untouched. |
| Screen call fails, returns bad JSON, or the row has no `name` | Same as above - it fails *open*, so a broken screen can never wrongly settle or fail a company. |

The prompt is deliberately conservative because the two errors are not
symmetric: a wrong `target` is recorded without anyone opening the website,
while `unsure` only costs the scrape you'd have done anyway. Generic words
(Group, Holdings, Partners, Solutions), bare surnames/brand names, and anything
containing finance/advisory/recruiting/legal words never qualify on their own.

What lands in the row's `metadata`, in both outcomes:

- `classification_source` - `name_screen` or `scrape`.
- `name_screen` - `{ verdict, confidence, reason, skipped_scrape, at }`, kept even
  when the screen fell through, so you can audit its calls.
- Screen tokens are added to the same cumulative `input_tokens` / `output_tokens`
  counters as everything else. For name-screened rows `scrape_provider` is `null`.

Trade-offs to know about:

- Every company that is *not* settled by name now costs one extra small model
  call (~300 input tokens; the prompt is under the 1,024-token caching minimum,
  so it isn't cached). It shares `ANTHROPIC_RPM` with the categorizer.
- A name-screened Target is only ever `Target`. The full path can assign a
  second category when the site shows a separate business line; the screen
  can't. Audit with `WHERE metadata->>'classification_source' = 'name_screen'`.
- Turn it off with `NAME_SCREEN_ENABLED=false` and behaviour is identical to
  before.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | entrypoint, cron, graceful shutdown |
| `src/pipeline.ts` | claim → name screen → scrape → classify → write back, worker pool |
| `src/llm.ts` | provider switch (`LLM_PROVIDER`) — the only file pipeline.ts/index.ts import from for LLM calls |
| `src/claudeAgent.ts` | Anthropic backend: client, prompt caching, cache pre-warm, usage extraction |
| `src/openaiAgent.ts` | OpenAI backend: client, automatic caching usage extraction, warm-up |
| `src/prompts.ts` | the two system prompts, shared verbatim by both backends |
| `src/categorization.ts` | categorizer JSON parsing/validation + category flattening, shared by both backends |
| `src/nameScreen.ts` | Anthropic-backed name + domain pre-screen call |
| `src/nameScreenParsing.ts` | name-screen input cleaning + output parsing, shared by both backends |
| `src/db.ts` | claim query, JSONB merge writes, token accumulation |
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
