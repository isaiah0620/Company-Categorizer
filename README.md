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

## HTTP API

Besides the scheduled batch job, the same pipeline is available on demand over
HTTP. Send one company or a list; for each domain the API either returns what
is already stored or researches it, stores the result, and returns that.

```bash
npm run dev:server           # from source
npm run build && npm run serve
```

Needs `API_KEY` (the server refuses to start without one - every request can
spend scrape and model credits) plus the same database / provider settings as
the batch job. Run `migration.sql` once: it adds an index the lookup uses.

### `POST /v1/companies/categorize`

Auth: `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`.

```jsonc
// one company                                  -> the result object directly
{ "domain": "stripe.com", "name": "Stripe" }

// several (also accepted: a bare top-level array, and plain domain strings)
{ "companies": [ { "domain": "stripe.com", "name": "Stripe" }, "acme.com" ] }

// ignore stored results for this call
{ "domain": "stripe.com", "force_refresh": true }
```

`domain` may be a bare host or a URL (`https://www.Acme.com/about` is treated
as `acme.com`; `website` / `url` are accepted as aliases). `name` is optional
but worth sending: it enables the name-screen shortcut, which can settle a
clearly-operating business without scraping at all. Max 25 companies per
request (`API_MAX_BATCH`).

**The rule.** A stored result is returned as-is when the row is `checked` *and*
was checked within the last `RESULT_MAX_AGE_MONTHS` (6) calendar months. "Checked
at" is `metadata.checked_at`, or the row's `updated_at` for older rows that never
had one. Anything else - no row, never checked, or older than that - goes through
the normal pipeline (name screen -> scrape -> classify), is written to the row
exactly as the batch job would write it, and is then read back and returned.

**Response, one company** (HTTP status reflects the outcome):

```json
{
  "domain": "acme.com",
  "name": "Acme Inc",
  "status": "ok",
  "source": "cache",
  "category": "Target",
  "sub_category": "SaaS",
  "note": "Target (SaaS): ...",
  "classification_source": "scrape",
  "checked_at": "2026-08-02T10:14:09.312Z"
}
```

`source` is `"cache"` (served from the database) or `"fresh"` (researched just
now). Fresh results also carry `refresh_reason`: `not_found`, `not_checked`,
`stale`, or `forced`.

**Response, several:** always HTTP 200, with per-company outcomes in input order:

```json
{ "summary": { "total": 3, "from_cache": 2, "researched": 1, "failed": 0, "in_progress": 0 },
  "results": [ { "domain": "...", "status": "ok", ... } ] }
```

Failures are per company (`status: "error"`, with `error_code` and `error`):

| `error_code` | Single-company HTTP | Meaning |
|---|---|---|
| `invalid_domain` | 400 | not a usable public hostname (`localhost`, IPs, garbage) |
| `processing_failed` | 502 | the scrape or model failed; the reason is stored in the row's `errors` too |
| `internal_error` | 500 | database problem; details are in the server log only |
| `in_progress` (`status: "in_progress"`) | 202 + `Retry-After` | someone else is still researching it - retry shortly |

When re-researching an older row fails, the error carries `last_known` (the
previous classification), so a flaky scrape doesn't leave you with nothing.

Other errors: `401` bad/missing key, `400` bad JSON or body, `413` too many
companies or body over 1 MB, `405`/`404`. `GET /health` (no auth) is a
liveness probe.

### Behaviour worth knowing

- **Synchronous.** A miss waits for the scrape and model calls, typically tens of
  seconds per company; a batch of misses runs `API_CONCURRENCY` at a time. Set
  your client and gateway timeouts accordingly (Cloud Run: `--timeout`). If the
  client disconnects, the research still finishes and is stored.
- **No double-paying.** Two requests for the same domain at once share one run.
  The API stamps `processing_started_at` on the row (the same claim the batch job
  uses), so the cron job skips a row the API is working on, the API waits for a
  row the cron job is working on (up to `API_WAIT_FOR_INFLIGHT_MS`), and separate
  API instances don't collide. A claim from a crashed process expires after
  `STALE_CLAIM_MS`.
- **Same rows as the batch job.** New domains are inserted with `id` = the bare
  domain and `added_via: "api"`. Token usage accumulates per row as usual.
- **Domain matching.** Existing rows are matched on `metadata.domain` or `id`,
  case-insensitively, tolerating a `www.` prefix, a scheme, and a trailing slash.
  Only a leading `www.` is stripped; `blog.acme.com` and `acme.com` are different
  companies here.
- **Failed refresh flips `checked` to false** (the pipeline's existing behaviour),
  so the next request retries it. Repeatedly calling with a domain that always
  fails will re-scrape every time.
- **SSH tunnel self-heals.** If Postgres is reached over an SSH tunnel and it drops
  (network blip, sshd restart, idle timeout), the API rebuilds the tunnel and
  connection pool on the next query - one rebuild however many requests arrive at
  once - instead of failing until the instance restarts. Requests that were mid-query
  when it dropped fail with `internal_error`; their rows are recoverable (see claims above).
- **Sheets mirroring** (`SHEET_WRITEBACK_ENABLED`) applies to API-researched rows
  too, if you have it on.

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

### 6. Tavily as the (only) crawler, with sitemap + multi-page text

Tavily can be the sole provider - no Firecrawl key needed:

```bash
TAVILY_ENABLED=true SCRAPE_PROVIDER=tavily SCRAPE_FALLBACK_PROVIDER=none \
TAVILY_API_KEY=tvly-... docker compose up --build
```

With `SITE_CRAWL_ENABLED=true` (default) each company goes through `src/siteCrawl.ts`:

1. **Map** - Tavily `/map` follows links from the homepage and returns the site's URLs -> saved to the **`sitemap`** column (TEXT, one URL per line).
2. **Select** - the homepage plus the pages most likely to describe the business (about, services, products, portfolio, investment criteria, ...); blog/news/careers/legal/PDF URLs are skipped.
3. **Extract** - those pages, as markdown, in one Tavily `/extract` call.
4. **Build** - each page is cleaned, capped (`SITE_MAX_CHARS_PER_PAGE`), labelled `=== PAGE: <url> ===`, and the total is capped (`SITE_MAX_TOTAL_CHARS`). This text is what the model receives and what is saved to the **`scraped_text`** column.

Both columns are written right after the crawl and *before* the model call, so a failed categorization never loses a paid crawl. Rows settled by the name screen are never crawled, so both columns stay `NULL` for them. `SITE_CRAWL_ENABLED=false` restores the old homepage-only behaviour (`sitemap` stays `NULL`). With Firecrawl as provider, `scraped_text` is filled from its single page and `sitemap` stays `NULL`.

Tavily Map discovers pages by following links; it does not read `/sitemap.xml`, so a page that nothing links to will not appear in `sitemap`.

**Existing database:** run `migration.sql` first (adds the two columns). The app checks for them at startup and refuses to run without them.

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
| `src/index.ts` | batch entrypoint, cron, graceful shutdown |
| `src/server.ts` | HTTP API entrypoint: auth, request parsing, routing |
| `src/research.ts` | API logic: cache check -> claim -> `processCompany()` -> read back |
| `src/domain.ts` | domain normalisation + the spellings to look up |
| `src/pipeline.ts` | claim → name screen → scrape → classify → write back, worker pool |
| `src/llm.ts` | provider switch (`LLM_PROVIDER`) — the only file pipeline.ts/index.ts import from for LLM calls |
| `src/claudeAgent.ts` | Anthropic backend: client, prompt caching, cache pre-warm, usage extraction |
| `src/openaiAgent.ts` | OpenAI backend: client, automatic caching usage extraction, warm-up |
| `src/prompts.ts` | the two system prompts, shared verbatim by both backends |
| `src/categorization.ts` | categorizer JSON parsing/validation + category flattening, shared by both backends |
| `src/nameScreen.ts` | Anthropic-backed name + domain pre-screen call |
| `src/nameScreenParsing.ts` | name-screen input cleaning + output parsing, shared by both backends |
| `src/db.ts` | claim query, JSONB merge writes, token accumulation, API lookup + claim |
| `src/scraper.ts` | provider selection and fallback |
| `src/firecrawl.ts`, `src/tavily.ts` | the two scrapers (Tavily: extract + map) |
| `src/siteCrawl.ts` | Tavily multi-page flow: map -> select pages -> extract -> build `scraped_text` |
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
npm run dev:server   # the HTTP API, from source (needs API_KEY)
docker compose up --build    # the real image, against a local Postgres
```

## Note on the SDK

The pinned `@anthropic-ai/sdk` (^0.32.0) passes `cache_control` through and
reports the cache usage fields. If you want first-class types for the 1-hour
TTL, `npm i @anthropic-ai/sdk@latest`.
