/**
 * HTTP entrypoint. Run it instead of index.ts:
 *
 *   npm run dev:server           (TypeScript source)
 *   npm run build && npm run serve
 *
 * POST /v1/companies/categorize
 *   { "domain": "acme.com", "name": "Acme Inc" }                 one company
 *   { "companies": [ { "domain": ..., "name": ... }, "b.com" ] } several
 *   [ { "domain": ... }, "b.com" ]                                several
 * Add "force_refresh": true to ignore stored results.
 *
 * GET /health   (no auth) liveness probe.
 *
 * See README.md, "HTTP API", for the response format.
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, validateApiConfig, validateConfig } from './config.js';
import { assertConnection, assertScrapeColumns, closePool, enableTransportRecovery } from './db.js';
import { normalizeDomain } from './domain.js';
import { inflightCount, researchCompanies, waitForIdle } from './research.js';
import type { ResearchInput, ResearchResult } from './research.js';
import { closeScrapers } from './scraper.js';
import { closeLlm } from './llm.js';

const ROUTE = '/v1/companies/categorize';
const MAX_NAME_LENGTH = 200;
const MAX_DOMAIN_INPUT_LENGTH = 2048;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Per-item validation failure. Never touches the database or a provider. */
interface InvalidResult {
  domain: string | null;
  name: string | null;
  status: 'error';
  error_code: 'invalid_domain';
  error: string;
}
type ItemResult = ResearchResult | InvalidResult;

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const keyDigests = (): Buffer[] => config.api.apiKeys.map(sha256);

/** Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`. Constant-time compare. */
function isAuthorized(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  const xKey = req.headers['x-api-key'];
  const provided =
    typeof auth === 'string' && /^bearer\s+/i.test(auth)
      ? auth.replace(/^bearer\s+/i, '').trim()
      : typeof xKey === 'string'
        ? xKey.trim()
        : '';
  if (!provided) return false;

  const digest = sha256(provided);
  // Compare against every key without stopping at the first match.
  return keyDigests().reduce((ok, key) => (timingSafeEqual(key, digest) ? true : ok), false);
}

/* ------------------------------------------------------------------ */
/* Request parsing                                                     */
/* ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // over the limit: discard the rest
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ParsedRequest {
  items: unknown[];
  /** True when the caller sent one company rather than a list. */
  single: boolean;
  forceRefresh: boolean;
}

function parseRequest(body: unknown): ParsedRequest {
  if (Array.isArray(body)) return { items: body, single: false, forceRefresh: false };
  if (!isObject(body)) {
    throw new HttpError(400, 'invalid_body', 'Body must be a company object, or a list of companies.');
  }

  const force = body.force_refresh;
  if (force !== undefined && typeof force !== 'boolean') {
    throw new HttpError(400, 'invalid_body', '"force_refresh" must be true or false.');
  }
  const forceRefresh = force === true;

  if ('companies' in body) {
    if (!Array.isArray(body.companies)) {
      throw new HttpError(400, 'invalid_body', '"companies" must be an array.');
    }
    return { items: body.companies, single: false, forceRefresh };
  }
  return { items: [body], single: true, forceRefresh };
}

/** A parsed item is either researchable, or already known to be invalid. */
type Slot = { ok: true; input: ResearchInput } | { ok: false; result: InvalidResult };

function toSlot(raw: unknown): Slot {
  const invalid = (domain: string | null, name: string | null, error: string): Slot => ({
    ok: false,
    result: { domain, name, status: 'error', error_code: 'invalid_domain', error },
  });

  let domainRaw: unknown;
  let nameRaw: unknown;
  if (typeof raw === 'string') {
    domainRaw = raw;
  } else if (isObject(raw)) {
    domainRaw = raw.domain ?? raw.website ?? raw.url;
    nameRaw = raw.name;
  } else {
    return invalid(null, null, 'Each company must be an object with a "domain", or a domain string.');
  }

  const name =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim().slice(0, MAX_NAME_LENGTH) : null;

  if (typeof domainRaw !== 'string' || !domainRaw.trim()) {
    return invalid(null, name, 'Missing "domain".');
  }
  if (domainRaw.length > MAX_DOMAIN_INPUT_LENGTH) {
    return invalid(null, name, '"domain" is too long.');
  }
  const domain = normalizeDomain(domainRaw);
  if (!domain) {
    return invalid(domainRaw.slice(0, 200), name, `"${domainRaw.slice(0, 200)}" is not a valid domain.`);
  }
  return { ok: true, input: { domain, name } };
}

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

function send(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Results change as companies are re-researched; never let a proxy hold one.
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, err: HttpError): void {
  send(
    res,
    err.status,
    { error: { code: err.code, message: err.message } },
    // A 413 is sent while the client may still be uploading; don't reuse the connection.
    err.status === 413 ? { Connection: 'close' } : {}
  );
}

/** HTTP status for a single-company request, from that company's result. */
function statusFor(result: ItemResult): number {
  if (result.status === 'ok') return 200;
  if (result.status === 'in_progress') return 202;
  switch (result.error_code) {
    case 'invalid_domain':
      return 400;
    case 'processing_failed':
      return 502; // the scrape or the model failed - not this API's fault, not the caller's
    default:
      return 500;
  }
}

function summarize(results: ItemResult[]): Record<string, number> {
  const count = (fn: (r: ItemResult) => boolean): number => results.filter(fn).length;
  return {
    total: results.length,
    from_cache: count((r) => r.status === 'ok' && r.source === 'cache'),
    researched: count((r) => r.status === 'ok' && r.source === 'fresh'),
    failed: count((r) => r.status === 'error'),
    in_progress: count((r) => r.status === 'in_progress'),
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function handleCategorize(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req, config.api.maxBodyBytes);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }

  const parsed = parseRequest(body);
  if (parsed.items.length === 0) {
    throw new HttpError(400, 'invalid_body', 'Provide at least one company.');
  }
  if (parsed.items.length > config.api.maxBatch) {
    throw new HttpError(
      413,
      'batch_too_large',
      `At most ${config.api.maxBatch} companies per request; got ${parsed.items.length}.`
    );
  }

  const slots = parsed.items.map(toSlot);
  const valid = slots.flatMap((s) => (s.ok ? [s.input] : []));
  const researched = valid.length
    ? await researchCompanies(valid, { forceRefresh: parsed.forceRefresh })
    : [];

  // Put results back in the order the caller sent them.
  let next = 0;
  const results: ItemResult[] = slots.map((s) => (s.ok ? (researched[next++] as ResearchResult) : s.result));

  if (parsed.single) {
    const only = results[0] as ItemResult;
    send(res, statusFor(only), only, only.status === 'in_progress' ? { 'Retry-After': '5' } : {});
    return;
  }
  send(res, 200, { summary: summarize(results), results });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?', 1)[0];

  if (path === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    send(res, 200, { status: 'ok' });
    return;
  }

  if (path === ROUTE) {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', `Use POST ${ROUTE}.`);
    }
    if (!isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'Missing or invalid API key.');
    }
    await handleCategorize(req, res);
    return;
  }

  throw new HttpError(404, 'not_found', 'No such route.');
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  handle(req, res)
    .catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err);
      console.error('[api] Unhandled error:', err);
      sendError(res, new HttpError(500, 'internal_error', 'Internal server error.'));
    })
    .finally(() => {
      if (req.url !== '/health') {
        console.log(
          `[api] ${req.method} ${req.url} -> ${res.statusCode} in ${Date.now() - started}ms`
        );
      }
    });
});

// Time to receive the request. Deliberately NOT setting server.timeout: a
// response legitimately takes as long as the scrape + model calls do.
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
// Longer than the load balancer's idle timeout, so it - not us - closes idle sockets.
server.keepAliveTimeout = 65_000;

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] Shutting down (${inflightCount()} run(s) in flight)...`);
  server.close();
  // Cloud Run gives ~10s after SIGTERM. Let paid-for work land in the database
  // if it can; anything left is re-claimable once STALE_CLAIM_MS passes.
  await waitForIdle(8_000);
  closeScrapers();
  closeLlm();
  await closePool().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  validateConfig();
  validateApiConfig();
  enableTransportRecovery();
  await assertConnection();
  await assertScrapeColumns();

  const model = config.llm.provider === 'openai' ? config.openai.model : config.anthropic.model;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.api.port, '0.0.0.0', () => resolve());
  });
  console.log(
    `[api] Listening on :${config.api.port}  POST ${ROUTE}` +
      `  provider=${config.llm.provider} model=${model} scraper=${config.scraper.primary}` +
      `  freshness=${config.api.resultMaxAgeMonths}mo max-batch=${config.api.maxBatch}` +
      `  concurrency=${config.api.concurrency}`
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

main().catch(async (err) => {
  console.error('[api] Fatal:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
