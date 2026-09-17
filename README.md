# company-categorizer-ts

A TypeScript port of `company-categorizer` (itself a Node.js port of the n8n
workflow that categorizes companies from a Google Sheet
("Companies - Uncategorized") by scraping their site with Firecrawl and
classifying them with Claude, then writing results back to the sheet and to
a Postgres `company_metadata` table).

Behavior, env vars, prompt, sheet columns, and deployment shape are
unchanged from the JS version — this is a straight type-safe rewrite, not
a redesign. If you've already run the JS version in production, you can
swap this in without touching your `.env`, your sheet, or your database.

## What changed vs. the JS version

- Every module (`config`, `googleSheets`, `firecrawl`, `claudeAgent`, `db`,
  `pipeline`, `index`) is now `.ts` with explicit types for sheet rows,
  Firecrawl responses, Claude's structured output, and the app config —
  see `src/types.ts` for the shared shapes.
- `tsc --strict` (plus `noUncheckedIndexedAccess`) is on, so column lookups,
  optional Firecrawl metadata fields, and Claude's JSON output are all
  checked at compile time instead of failing at runtime.
- Build step added: `npm run build` compiles `src/**/*.ts` to `dist/`
  (via `tsc`, `NodeNext` module resolution). `npm start` / `npm run
  run-once` now run the compiled `dist/index.js`, matching how the
  Dockerfile runs it.
- `npm run dev` / `npm run dev:once` run the pipeline directly from
  TypeScript source via `tsx` — no compile step needed while iterating.
- `npm run typecheck` runs `tsc --noEmit` for CI/pre-commit checks without
  producing output files.
- Dockerfile is now a two-stage build: a `build` stage installs
  devDependencies and compiles TypeScript, then the runtime stage installs
  only production dependencies and copies in the compiled `dist/` —
  keeping the final image the same shape as the JS version's.

## How it maps to the original n8n nodes

| n8n node(s) | TypeScript equivalent |
|---|---|
| Schedule Trigger | `node-cron` in `src/index.ts` |
| Get row(s) in sheet | `getRows()` in `src/googleSheets.ts` |
| If8 / If6 / If (unprocessed filter) | `selectUnprocessedRows()` in `src/pipeline.ts` |
| Limit | `.slice(0, batchSize)` in `src/pipeline.ts` |
| Loop Over Items / Wait | `for...of` loop + `sleep()` in `src/pipeline.ts` |
| /map, /scrape | `src/firecrawl.ts` |
| If3 / If7 (status code check) | inline check in `processCompany()` |
| Code in JavaScript2 (strip images) | `src/cleanMarkdown.ts` |
| AI Agent2 + Structured Output Parser2 | `src/claudeAgent.ts` (`categorizeCompany`) |
| Code in JavaScript1 (combine categories) | `combineCategories()` in `src/claudeAgent.ts` |
| Update row in sheet / sheet2 / sheet4 | `updateRowByDomain()` in `src/googleSheets.ts` |
| Insert or update rows in a table | `upsertCompanyMetadata()` in `src/db.ts` |

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Google Sheets access** — create a service account in Google Cloud
   Console, enable the Sheets API, download its JSON key, then share your
   spreadsheet with the service account's `client_email` as an Editor.

3. **Postgres** — run `schema.sql` against your database to create the
   `company_metadata` table (skip if it already exists). If your Postgres
   is only reachable by SSHing into its host first, see "Connecting
   through an SSH tunnel" below.

4. **Environment variables** — copy `.env.example` to `.env` and fill in:
   - Google service account email/key, spreadsheet ID, sheet name
   - Firecrawl API key
   - Anthropic API key (and model — defaults to `claude-sonnet-4-6`)
   - Postgres connection string
   - Optional pipeline tuning (batch size, delays, cron schedule)

5. **Run once, from TypeScript source (for testing/iterating)**
   ```bash
   npm run dev:once
   ```

6. **Build and run on a schedule** (default every 15 minutes, matching the
   original workflow)
   ```bash
   npm run build
   npm start
   ```

## Connecting through an SSH tunnel

If your Postgres server is only reachable by SSHing into its VPS first,
set these in `.env`:

```
SSH_TUNNEL_ENABLED=true
SSH_HOST=your-vps-ip-or-hostname
SSH_PORT=22
SSH_USERNAME=deploy
SSH_PRIVATE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"
```
(or `SSH_PASSWORD` instead of a key, if that's how you authenticate).

Then point `DATABASE_URL` at Postgres's address **as seen from the VPS
itself** — usually `127.0.0.1:5432`:
```
DATABASE_URL=postgresql://dbuser:dbpass@127.0.0.1:5432/dbname
```

At startup, the app opens the SSH connection, forwards a local port
through it to `127.0.0.1:5432` on the far side, and connects Postgres
through that forwarded port (`src/db.ts`, via the `tunnel-ssh` package).
Put `SSH_PRIVATE_KEY` in Secret Manager alongside your other credentials
when deploying (see `deploy/gcp-setup.sh`).

## Notes / things to double check against your real sheet

- The sheet is expected to have columns named exactly: `Domains`, `Category`,
  `Sub Category`, `Note`, `Checked`, `Errors`. Adjust `src/googleSheets.ts`
  (and the `SheetRow` / `SheetUpdateFields` types in `src/types.ts`) if your
  headers differ.
- `Checked` is written as the string `"True"` to match the original
  workflow; change the value in `src/pipeline.ts` if you'd rather use a
  boolean/checkbox.
- The Firecrawl `/map` call isn't wired into the categorization prompt
  here either — it's included in `src/firecrawl.ts` (`mapDomain`) but
  unused by default. Wire it in if you want to scrape multiple pages per
  domain instead of just the homepage.
- Rate limiting is handled with simple `sleep()` delays
  (`SCRAPE_DELAY_MS`, `BETWEEN_COMPANY_DELAY_MS`) — tune these to your
  Firecrawl/Anthropic rate limits.
- For production use, consider running this under a process manager (pm2,
  systemd, a Docker container + cron) rather than a bare `node dist/index.js`
  long-running process.

## Running in Docker

```bash
docker build -t company-categorizer-ts .
docker run --rm --env-file .env company-categorizer-ts          # one batch, then exit
```

The image's default command is `node dist/index.js --once` (one batch per
container run) — this is what makes it a good fit for Cloud Run **Jobs**
(see below). If you want the container to run the internal `node-cron`
scheduler instead (e.g. for a VM or always-on host), override the command:

```bash
docker run --rm --env-file .env company-categorizer-ts node dist/index.js
```

## Testing locally before touching Cloud Run

`docker-compose.yml` spins up a throwaway local Postgres (schema auto-applied
from `schema.sql`) alongside the app container, so you can run the exact
image Cloud Run will run — against real Google Sheets/Firecrawl/Anthropic,
but a disposable local database:

```bash
docker compose up --build
```

This runs one batch and exits. Re-run `docker compose up` any time to run
another batch. To poke around the local database:

```bash
docker exec -it company-categorizer-db psql -U categorizer -d company_categorizer -c "SELECT id, metadata->>'companyName' FROM company_metadata;"
```

Tear it down (and wipe the local DB) with `docker compose down -v`.

## Running entirely on your own computer (no Cloud Run)

Everything above also works as your permanent setup, not just for testing —
there's no cloud bill either way since it's your own hardware. The one
real trade-off: your computer has to be on and awake whenever a run should
fire. Two ways to do it:

- **Always-on container** — edit the `app` service's `command` in
  `docker-compose.yml` to `["node", "dist/index.js"]` (drop `--once`) and add
  `restart: unless-stopped`, then `docker compose up -d --build`. The
  container schedules itself via `node-cron`, same as `npm start`.
- **OS scheduler + `--once`** — leave the default command as-is, keep just
  Postgres running (`docker compose up -d postgres`), and let cron
  (macOS/Linux) or Task Scheduler (Windows) run
  `docker compose run --rm app` every 15 minutes.

**Use a scratch copy of your Google Sheet while testing** (File → Make a
copy), share it with the same service account, and point
`GOOGLE_SPREADSHEET_ID` at the copy. Also set `BATCH_SIZE=1` or `2` in
`.env` while testing to keep Firecrawl/Anthropic usage (and cost) minimal.

## Deploying to Google Cloud Run

This app has no HTTP server — it wakes up, processes a batch of rows, and
exits. That maps onto **Cloud Run Jobs**, not Cloud Run Services. See
`deploy/gcp-setup.sh` for the full set of `gcloud` commands (Artifact
Registry, Secret Manager, Cloud Run Job, Cloud Scheduler, IAM). It's meant
to be read and run step by step, not executed blindly.
