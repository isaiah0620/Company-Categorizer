# Setup guide

Two parts: get it running on your own machine first, then put the same image
on Cloud Run. Do them in that order — every mistake is ten times cheaper to
find locally.

---

# Part 1 — On your own system

## 1.1 What you need first

| Thing | Why | Check |
|---|---|---|
| Node.js 20+ | runs the app | `node -v` |
| Docker Desktop (or Docker Engine + compose) | runs the throwaway Postgres, and builds the image Cloud Run will run | `docker compose version` |
| `psql` (optional but useful) | poking at the database | `psql --version` |
| Anthropic API key | classification | starts `sk-ant-` |
| Firecrawl API key | scraping | starts `fc-` |
| Tavily API key | only if you turn Tavily on | starts `tvly-` |
| Your Postgres connection string | the work queue | `postgresql://user:pass@host:5432/db` |

## 1.2 Install

```bash
npm install
cp .env.example .env
```

## 1.3 Fill in `.env`

Minimum to start:

```bash
ANTHROPIC_API_KEY=sk-ant-...
FIRECRAWL_API_KEY=fc-...
DATABASE_URL=postgresql://user:pass@host:5432/dbname
DATABASE_SSL=true          # true for Neon/Supabase/RDS, false for local
```

Then set the throughput knobs to match **your** plans:

```bash
FIRECRAWL_RPM=20           # your Firecrawl plan's scrapes per minute
ANTHROPIC_RPM=40           # your Anthropic tier's requests per minute
PIPELINE_CONCURRENCY=4
BATCH_SIZE=25
ANTHROPIC_CACHE_TTL=1h     # see "Prompt caching" below
```

Google Sheets variables are **optional now** and can stay empty. The pipeline
reads its work from Postgres. Set `SHEET_WRITEBACK_ENABLED=true` only if you
still want results mirrored into the old spreadsheet.

## 1.4 Prepare the database

If the table already exists with your rows, apply the additive migration:

```bash
psql "$DATABASE_URL" -f migration.sql
```

That adds a partial index over the unchecked rows (so the polling query stays
fast as the table grows), a domain index, and a `company_token_usage` view.
No rows are rewritten.

For a brand-new database, use `schema.sql` instead — it creates the table too.

Sanity check that the app will see work:

```sql
SELECT count(*) FROM public.company_metadata
 WHERE COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE;
```

## 1.5 First run — one company, against a scratch database

Do not point the first run at production. Spin up the local Postgres:

```bash
docker compose up -d postgres
```

Seed it with a couple of real rows (edit the domains):

```bash
docker exec -i company-categorizer-db psql -U categorizer -d company_categorizer <<'SQL'
INSERT INTO public.company_metadata (id, metadata) VALUES
  ('burtonhillcapital.com', '{"name":"Burton Hill Capital","domain":"burtonhillcapital.com","checked":null}'),
  ('stripe.com',            '{"name":"Stripe","domain":"stripe.com","checked":null}')
ON CONFLICT (id) DO NOTHING;
SQL
```

Point the app at it and run one batch from source:

```bash
DATABASE_URL=postgresql://categorizer:localtestpassword@localhost:5432/company_categorizer \
DATABASE_SSL=false BATCH_SIZE=2 PIPELINE_CONCURRENCY=2 \
npm run dev:once
```

You should see, in order: the claim count, a cache warm line, one `[claude]`
line per company with its token counts, and a run summary.

## 1.6 Check the results and the token accounting

```bash
docker exec -it company-categorizer-db psql -U categorizer -d company_categorizer \
  -c "SELECT domain, category, input_tokens, output_tokens, cache_read_input_tokens FROM company_token_usage;"
```

Every processed row now carries, inside `metadata`:

| Key | Meaning |
|---|---|
| `category`, `sub_category`, `note` | the classification |
| `checked` | `true` (JSON boolean) — this is what takes the row out of the queue |
| `checked_at` | when it was finished |
| `errors` | failure message, or `null` on success |
| `input_tokens`, `output_tokens` | **cumulative** across attempts |
| `cache_read_input_tokens`, `cache_creation_input_tokens` | cache hits / writes |
| `last_run_usage` | the most recent call's breakdown, with model and timestamp |
| `scrape_provider` | `firecrawl` or `tavily` |

Everything else in the row — `record_id`, `row_number`, `created_by`,
`last_interaction_with`, `industry_thesis` — is untouched. Every write is a
JSONB merge, never a replace.

Spend across the whole table:

```sql
SELECT sum(input_tokens)  AS input,
       sum(output_tokens) AS output,
       sum(cache_read_input_tokens)     AS cache_read,
       sum(cache_creation_input_tokens) AS cache_write
  FROM company_token_usage;
```

## 1.7 Run the real image

```bash
docker compose up --build          # builds, runs one batch, exits
```

With Tavily on:

```bash
TAVILY_ENABLED=true TAVILY_API_KEY=tvly-... docker compose up --build
```

With Tavily as the *primary* scraper:

```bash
TAVILY_ENABLED=true SCRAPE_PROVIDER=tavily TAVILY_API_KEY=tvly-... docker compose up --build
```

Tear down and wipe the local database: `docker compose down -v`.

## 1.8 Point at the real database

When the scratch run looks right, comment out the `DATABASE_URL:` line in the
`app` service in `docker-compose.yml` so the app uses the one from `.env`,
start with `BATCH_SIZE=5`, and check the rows before raising it.

## 1.9 If you reach Postgres through an SSH bastion

This is supported and unchanged in shape, but the new concurrency makes the
tunnel carry more than it used to, so set it up deliberately.

```bash
SSH_TUNNEL_ENABLED=true
SSH_HOST=your-vps-ip
SSH_PORT=22
SSH_USERNAME=deploy
SSH_PRIVATE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n"
SSH_READY_TIMEOUT_MS=20000

# host:port as seen FROM THE VPS ITSELF - almost always loopback
DATABASE_URL=postgresql://dbuser:dbpass@127.0.0.1:5432/dbname
DATABASE_SSL=false          # the tunnel is the encryption; don't stack TLS on top
DATABASE_POOL_MAX=5         # = PIPELINE_CONCURRENCY + 1
```

What to know:

- **One tunnel, several channels.** The app opens the tunnel once at startup
  and the pg pool sends `PIPELINE_CONCURRENCY + 1` connections through it.
  Each is a separate forwarded channel. If sshd on the bastion is locked down
  (`MaxSessions`, `MaxStartups`), lower `DATABASE_POOL_MAX` — and note that
  lowering it below `PIPELINE_CONCURRENCY + 1` makes workers queue for a
  connection, which is fine but caps throughput.
- **Keepalives are on** (15s, 4 misses). Runs now last minutes rather than
  seconds, so an sshd `ClientAliveInterval` would otherwise drop the tunnel
  mid-batch.
- **A dead tunnel ends the run cleanly.** Tunnel errors are logged rather than
  crashing the process, and the workers stop claiming new companies instead of
  scraping and classifying rows whose results can't be written. Those rows are
  reclaimable after `STALE_CLAIM_MS`.
- **Test the tunnel by itself first**, before involving the app:
  ```bash
  ssh -i /path/to/key -L 55432:127.0.0.1:5432 deploy@your-vps -N &
  psql "postgresql://dbuser:dbpass@127.0.0.1:55432/dbname" -c "select count(*) from public.company_metadata;"
  ```
  If that fails, nothing in the app will help.

### SSH by password (no key pair)

If you log into the VPS with just its IP and a password, that's fully
supported — set `SSH_PASSWORD` instead of `SSH_PRIVATE_KEY`. Nothing else is
required:

```bash
SSH_TUNNEL_ENABLED=true
SSH_HOST=your-vps-ip
SSH_PORT=22
SSH_USERNAME=deploy
SSH_PASSWORD=your-password

DATABASE_URL=postgresql://dbuser:dbpass@127.0.0.1:5432/dbname
DATABASE_SSL=false
```

That's enough to connect. One thing worth knowing about what this does *not*
cover: with no key pair, `ssh2` (the library the tunnel uses) accepts
whatever host key the server presents — there's no `~/.ssh/known_hosts` file
in a container to check it against. In practice that means the password is
the only thing standing between this tunnel and someone who manages to
intercept the connection and present themselves as your VPS. The app logs a
one-line warning (`connecting without host key verification`) each time it
opens the tunnel this way, as a reminder rather than a blocker.

**If you want to close that gap, pin the fingerprint** — optional, and the
rest of this section is only needed if you do:

```bash
SSH_HOST_FINGERPRINT=a1b2c3d4e5f6...
```

Once set, every connection is checked against it and rejected on a mismatch
(`SSH host key fingerprint mismatch!` in the logs) instead of silently
tunneling through whatever now answers on that IP. Capture it once, over a
connection you trust (e.g. your own laptop, first time connecting):

```bash
ssh-keyscan -T 5 your-vps-ip 2>/dev/null | ssh-keygen -lf - -E sha256
```

That prints something like:

```
256 SHA256:a1b2c3d4e5f6.... your-vps-ip (ED25519)
```

Take the part after `SHA256:` — that's a base64 fingerprint, not what this
app needs. Get the lowercase hex form directly instead:

```bash
node -e "
const crypto = require('crypto');
const { execSync } = require('child_process');
const keys = execSync('ssh-keyscan -T 5 your-vps-ip 2>/dev/null').toString().trim().split('\n');
for (const line of keys) {
  const parts = line.split(' ');
  const keyB64 = parts[2];
  if (!keyB64) continue;
  const hash = crypto.createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex');
  console.log(parts[1], hash);
}
"
```

That gives you one line per host key type the server offers (`ssh-ed25519`,
`rsa-sha2-512`, etc.) with its hex SHA256 digest. Verify one of these out of
band — call whoever manages the VPS, or check your hosting provider's
console/dashboard — before pinning it, since trusting the first
`ssh-keyscan` output blindly is the same gap pinning is meant to close.

Once verified:

```bash
SSH_TUNNEL_ENABLED=true
SSH_HOST=your-vps-ip
SSH_PORT=22
SSH_USERNAME=deploy
SSH_PASSWORD=your-password
SSH_HOST_FINGERPRINT=a1b2c3d4e5f6...     # the hex digest you just verified

DATABASE_URL=postgresql://dbuser:dbpass@127.0.0.1:5432/dbname
DATABASE_SSL=false
```

If the server's host key ever changes (VPS rebuilt, provider rotated it), the
app logs `SSH host key fingerprint mismatch!` and refuses to connect rather
than silently tunneling through whatever now answers on that IP. Re-run the
capture step and confirm the new fingerprint the same way before updating
`SSH_HOST_FINGERPRINT`.

**A password over the open internet is also worth hardening on the VPS side**,
independent of anything above:
- `fail2ban` (or equivalent) on sshd, so repeated bad-password attempts get
  banned — genuinely likely here, since Cloud Run's egress IP isn't something
  you can pre-authorize the way you could with key-only auth.
- A long, random password, not something memorized — you're pasting it into
  `.env` / Secret Manager, not typing it, so there's no reason to keep it typeable.
- If your hosting provider offers it, restrict SSH to your known egress ranges
  in addition to the app-level fingerprint pin — the pin stops MITM, not
  brute-force from anywhere.

## 1.10 Running permanently on your own machine (no cloud)

- **Always-on container:** in `docker-compose.yml`, change the `app` command
  to `["node", "dist/index.js"]` and add `restart: unless-stopped`, then
  `docker compose up -d --build`. It schedules itself with `SCHEDULE_CRON`.
- **OS scheduler:** leave the default `--once` command and let cron or Task
  Scheduler run `docker compose run --rm app` on your preferred cadence.

---

# Part 2 — On Google Cloud Run

This app has no HTTP server: it wakes, works a batch, exits. That is a Cloud
Run **Job**, not a Service. A Service would have to stay warm 24/7 to run
node-cron inside it and you'd pay for idle time; a Job bills only while it
runs.

`deploy/gcp-setup.sh` has every command below in copy-paste order. Read it,
edit the variables at the top, run the sections one at a time.

## 2.1 Variables and APIs

```bash
export PROJECT_ID=your-project
export REGION=us-central1
gcloud config set project "$PROJECT_ID"

gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com sqladmin.googleapis.com
```

## 2.2 Artifact Registry

```bash
gcloud artifacts repositories create company-categorizer-ts \
  --repository-format=docker --location="$REGION"
```

## 2.3 Secrets

Anything that is a credential goes in Secret Manager; anything you may want to
tune later goes in plain env vars so you can change it without a rebuild.

```bash
printf '%s' 'sk-ant-...' | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
printf '%s' 'fc-...'     | gcloud secrets create FIRECRAWL_API_KEY --data-file=-
printf '%s' 'postgresql://user:pass@host:5432/db' | gcloud secrets create DATABASE_URL --data-file=-
# only if you use Tavily:
printf '%s' 'tvly-...'   | gcloud secrets create TAVILY_API_KEY --data-file=-
# only if Postgres is behind an SSH bastion, key auth:
gcloud secrets create SSH_PRIVATE_KEY --data-file=/path/to/id_ed25519
# ...or password auth instead of a key:
printf '%s' 'your-ssh-password' | gcloud secrets create SSH_PASSWORD --data-file=-
```

## 2.4 How Cloud Run reaches your Postgres

Pick the one that matches your setup:

- **Cloud SQL** — add `--add-cloudsql-instances=PROJECT:REGION:INSTANCE` to the
  job, and use the socket form:
  `postgresql://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE`.
  Leave `DATABASE_SSL=false`.
- **Neon / Supabase / any public hosted Postgres** — normal connection string,
  `DATABASE_SSL=true`.
- **Postgres on a private VPS, reached over SSH** — this is your setup. Keep
  `SSH_TUNNEL_ENABLED=true`, store the key as a secret, and read the caveats
  below.

### SSH tunnel from Cloud Run

Add to the job:

With a key:

```bash
  --set-env-vars="...,SSH_TUNNEL_ENABLED=true,SSH_HOST=your-vps-ip,SSH_PORT=22,SSH_USERNAME=deploy,SSH_READY_TIMEOUT_MS=20000,DATABASE_SSL=false,DATABASE_POOL_MAX=5" \
  --set-secrets="...,SSH_PRIVATE_KEY=SSH_PRIVATE_KEY:latest"
```

Store the key with real newlines — Secret Manager handles them fine:

```bash
gcloud secrets create SSH_PRIVATE_KEY --data-file=/path/to/id_ed25519
```

With a password (this is your setup):

```bash
printf '%s' 'your-ssh-password' | gcloud secrets create SSH_PASSWORD --data-file=-

  --set-env-vars="...,SSH_TUNNEL_ENABLED=true,SSH_HOST=your-vps-ip,SSH_PORT=22,SSH_USERNAME=deploy,SSH_READY_TIMEOUT_MS=20000,DATABASE_SSL=false,DATABASE_POOL_MAX=5" \
  --set-secrets="...,SSH_PASSWORD=SSH_PASSWORD:latest"
```

That's sufficient to connect — no fingerprint required. If you'd rather pin
the host key (recommended, optional — see §1.9 "SSH by password" for why and
how to capture it), add `SSH_HOST_FINGERPRINT=...` to `--set-env-vars`; it
isn't a secret, since it identifies the server rather than granting access,
so it doesn't need `--set-secrets`.

```bash
  --set-env-vars="...,SSH_HOST_FINGERPRINT=a1b2c3d4e5f6..."
```

Three things that bite here specifically:

1. **Egress IP.** By default a Cloud Run Job's outbound traffic comes from a
   rotating Google IP, so a bastion with `sshd` firewalled to known addresses
   will refuse it. Either allow SSH from anywhere and rely on key-only auth
   (`PasswordAuthentication no`), or give the job a fixed source address:
   Direct VPC egress on a subnet with Cloud NAT and a reserved static IP, then
   allow only that IP on port 22.
2. **Tunnel setup is per execution.** Every scheduled run pays the SSH
   handshake again (a second or two). That is an argument for a larger
   `BATCH_SIZE` and a less frequent schedule rather than tiny frequent runs.
3. **`fail2ban` on the bastion.** A run every 15 minutes is 96 connections a
   day from one address. If a run ever fails auth repeatedly, fail2ban will
   ban the Cloud Run egress range. Whitelist your static egress IP once you
   have one.

Verify the credentials work before deploying, using the same key you put in
Secret Manager:

```bash
ssh -i /path/to/id_ed25519 -o BatchMode=yes deploy@your-vps 'echo tunnel-ok'
```

## 2.5 Build and push

```bash
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/company-categorizer-ts/company-categorizer-ts:latest"
gcloud builds submit --tag "$IMAGE" .
```

## 2.6 Create the Job

```bash
gcloud run jobs create company-categorizer-ts \
  --image="$IMAGE" --region="$REGION" \
  --cpu=1 --memory=512Mi --max-retries=1 --task-timeout=900s \
  --set-env-vars="ANTHROPIC_MODEL=claude-sonnet-4-6,ANTHROPIC_CACHE_TTL=1h,ANTHROPIC_RPM=40,ANTHROPIC_CONCURRENCY=4,FIRECRAWL_RPM=20,FIRECRAWL_CONCURRENCY=4,BATCH_SIZE=25,PIPELINE_CONCURRENCY=4,DATABASE_SSL=true,TAVILY_ENABLED=false" \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,FIRECRAWL_API_KEY=FIRECRAWL_API_KEY:latest,DATABASE_URL=DATABASE_URL:latest"
```

Note `--max-retries=1`: a retried task would re-claim rows, and every claim
costs scrape and model credits. Failures are already recorded per row in
`metadata.errors`, so let the next scheduled run pick them up instead.

## 2.7 Schedule it

```bash
SA=company-categorizer-ts-invoker
gcloud iam service-accounts create "$SA" \
  --display-name="Invokes the company-categorizer-ts Cloud Run Job"

gcloud run jobs add-iam-policy-binding company-categorizer-ts \
  --region="$REGION" \
  --member="serviceAccount:${SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http company-categorizer-ts-trigger \
  --location="$REGION" --schedule="*/15 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/company-categorizer-ts:run" \
  --http-method=POST \
  --oauth-service-account-email="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"
```

Two runs overlapping is safe: rows are claimed with `FOR UPDATE SKIP LOCKED`,
so a second execution picks up different rows rather than duplicating work.

## 2.8 Test and watch

```bash
gcloud run jobs execute company-categorizer-ts --region="$REGION" --wait
gcloud run jobs executions list --job=company-categorizer-ts --region="$REGION"
gcloud beta run jobs executions logs read EXECUTION_NAME --region="$REGION"
```

Then confirm in the database:

```sql
SELECT count(*) FILTER (WHERE metadata->>'checked' = 'true')  AS done,
       count(*) FILTER (WHERE metadata->>'errors' IS NOT NULL) AS errored
  FROM public.company_metadata;
```

## 2.9 Changing settings later

No rebuild needed for anything in env vars:

```bash
gcloud run jobs update company-categorizer-ts --region="$REGION" \
  --update-env-vars="BATCH_SIZE=50,PIPELINE_CONCURRENCY=6"
```

Turning Tavily on in production:

```bash
printf '%s' 'tvly-...' | gcloud secrets create TAVILY_API_KEY --data-file=-
gcloud run jobs update company-categorizer-ts --region="$REGION" \
  --update-env-vars="TAVILY_ENABLED=true,SCRAPE_FALLBACK_PROVIDER=tavily" \
  --update-secrets="TAVILY_API_KEY=TAVILY_API_KEY:latest"
```

---

# Tuning and troubleshooting

## Picking the throughput numbers

Start with your providers' published limits, not with guesses:

1. Set `FIRECRAWL_RPM` and `ANTHROPIC_RPM` to your plan's actual per-minute
   limits.
2. Set `PIPELINE_CONCURRENCY` to roughly `min(FIRECRAWL_RPM, ANTHROPIC_RPM) / 6`
   — a company takes about 6–10 seconds end to end, so that keeps the workers
   busy without the limiters queueing constantly. 4 is a sane default.
3. Raise `BATCH_SIZE` until a run reliably finishes inside the Cloud Run task
   timeout (900s at concurrency 4 is roughly 300–500 companies of headroom;
   50–100 is a comfortable batch).

If you see `[ratelimit:...] 429 received`, the limiter has already halved its
own rate and will walk it back up. Occasional 429s are fine and self-correct.
Constant ones mean your configured RPM is above your real limit — lower it.

## Prompt caching

`5m` vs `1h` comes down to your cron interval:

- Runs closer together than 5 minutes → `5m` (refreshed free on every hit).
- Runs every 15 minutes → `1h`. The cache survives between runs, so the first
  company of each run is a hit instead of a write. Writes cost 2x base input
  instead of 1.25x, reads are the same either way.

Verify it is working — cache reads should dominate after the first company:

```sql
SELECT sum(cache_read_input_tokens) AS read,
       sum(cache_creation_input_tokens) AS written,
       sum(input_tokens) AS uncached
  FROM company_token_usage;
```

If both cache columns are 0, the cached prefix is under the model's minimum
(1,024 tokens for Sonnet 4.x/5; 4,096 for Opus 4.5/4.6 and Haiku 4.5). The app
logs a warning the first time it sees this. With `claude-sonnet-4-6` and the
shipped prompt (~1.6k tokens) it caches; if you switch to an Opus 4.5/4.6 or
Haiku 4.5 model, caching silently stops paying off.

## Rows that get stuck

A row is claimed by stamping `processing_started_at`. If the process dies
mid-run the stamp stays, and the row becomes claimable again after
`STALE_CLAIM_MS` (default 15 minutes). To force it immediately:

```sql
UPDATE public.company_metadata
   SET metadata = metadata - 'processing_started_at'
 WHERE metadata ? 'processing_started_at';
```

## Reprocessing

```sql
-- retry everything that errored
UPDATE public.company_metadata
   SET metadata = metadata || '{"errors": null}'::jsonb
 WHERE metadata->>'errors' IS NOT NULL;
```

Or set `RETRY_ERRORED=true` to have each run pick errored rows back up
automatically. Token counters keep accumulating across attempts, so the cost
of a retried row stays visible.
