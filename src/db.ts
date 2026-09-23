import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import type { Server } from 'net';
import { config } from './config.js';
import type { CompanyMetadata, PendingCompany, TokenUsage } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let tunnelServer: Server | null = null;
let sshConnection: { end: () => void } | null = null;
let tunnelHealthy = true;

const TABLE = config.database.table;

/**
 * "checked is not true", written so it can never throw on unexpected data.
 *
 * `(metadata->>'checked')::boolean` is the literal translation, but it raises
 * on any value that isn't boolean-ish, which would abort the whole batch
 * because one row has "yes please" in it. This form treats NULL, missing,
 * empty string and anything unrecognised as "not checked", which is exactly
 * the rows we want to pick up.
 */
const NOT_CHECKED = `COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE`;

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

async function openSshTunnel(connectionString: string): Promise<string> {
  const dbUrl = new URL(connectionString);
  const dstAddr = dbUrl.hostname;
  const dstPort = Number(dbUrl.port || 5432);

  const sshOptions: Record<string, unknown> = {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    // The tunnel now carries several concurrent pg connections for a run that
    // may last minutes, instead of one connection used for a few seconds. Keep
    // the transport alive so an idle-timeout on the VPS's sshd doesn't drop it
    // mid-batch, and fail fast if the handshake itself hangs.
    readyTimeout: config.ssh.readyTimeoutMs,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
  };

  if (config.ssh.privateKey) {
    sshOptions.privateKey = config.ssh.privateKey;
    if (config.ssh.passphrase) sshOptions.passphrase = config.ssh.passphrase;
  } else if (config.ssh.password) {
    sshOptions.password = config.ssh.password;
    // Pinning SSH_HOST_FINGERPRINT is optional. When it's set, the connection
    // is verified against it and rejected on a mismatch. When it's not,
    // ssh2's default behaviour applies: it accepts whatever host key the
    // server presents, with no verification at all - there is no
    // ~/.ssh/known_hosts here to fall back on. That's a deliberate choice to
    // support environments where pinning isn't practical, but it does mean
    // password auth alone is what stands between this tunnel and a
    // man-in-the-middle, since (unlike key auth) there's no client-side
    // secret an attacker would additionally need.
    if (config.ssh.hostFingerprint) {
      sshOptions.hostHash = 'sha256';
      sshOptions.hostVerifier = (hashedKey: string): boolean => {
        const match = hashedKey.toLowerCase() === config.ssh.hostFingerprint?.toLowerCase();
        if (!match) {
          console.error(
            `[db] SSH host key fingerprint mismatch! Expected ${config.ssh.hostFingerprint}, ` +
              `got ${hashedKey}. Refusing to connect - this may be a man-in-the-middle.`
          );
        }
        return match;
      };
    } else {
      console.warn(
        '[db] SSH_PASSWORD is set without SSH_HOST_FINGERPRINT - connecting without host key ' +
          'verification. Set SSH_HOST_FINGERPRINT to pin the server\'s key (see SETUP.md "SSH by password").'
      );
    }
  } else {
    throw new Error(
      'SSH_TUNNEL_ENABLED is true but neither SSH_PRIVATE_KEY nor SSH_PASSWORD is set'
    );
  }

  const [server, connection] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    { host: '127.0.0.1', port: 0 },
    sshOptions,
    { dstAddr, dstPort }
  );

  tunnelServer = server as Server;
  sshConnection = connection as { end: () => void };

  // Without these, a tunnel that dies mid-run (network blip, sshd restart)
  // surfaces as an unhandled 'error' event and takes the whole process down
  // with it, losing the rest of the batch. Logged instead: the in-flight
  // queries fail, their rows record the error, and the next run reclaims them
  // once STALE_CLAIM_MS has passed.
  const onTunnelError = (err: Error): void => {
    tunnelHealthy = false;
    console.error(`[db] SSH tunnel error: ${err.message}`);
  };
  (tunnelServer as unknown as { on(e: string, cb: (err: Error) => void): void }).on(
    'error',
    onTunnelError
  );
  (sshConnection as unknown as { on(e: string, cb: (err: Error) => void): void }).on(
    'error',
    onTunnelError
  );
  tunnelHealthy = true;

  const localPort = (tunnelServer.address() as { port: number }).port;
  console.log(
    `[db] SSH tunnel up: 127.0.0.1:${localPort} -> ${config.ssh.host} -> ${dstAddr}:${dstPort}`
  );

  dbUrl.hostname = '127.0.0.1';
  dbUrl.port = String(localPort);
  return dbUrl.toString();
}

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const connectionString = config.ssh.enabled
    ? await openSshTunnel(config.database.connectionString)
    : config.database.connectionString;

  pool = new Pool({
    connectionString,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    // One connection per worker, plus a spare for the claim query. Through an
    // SSH tunnel each of these is a separate forwarded channel, so DATABASE_POOL_MAX
    // is there to cap it if the bastion's sshd is configured restrictively.
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  if (config.ssh.enabled) {
    console.log(`[db] Pool max ${config.database.poolMax} connection(s) over the SSH tunnel.`);
  }
  return pool;
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

/** How many rows are still waiting, for logging. */
export async function countPending(): Promise<number> {
  const client = await getPool();
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${TABLE} WHERE ${NOT_CHECKED}`
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Claims up to `limit` unchecked rows and returns them.
 *
 * This is a single atomic UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)
 * rather than a plain SELECT, for two reasons:
 *
 *  - SKIP LOCKED means two overlapping runs (a slow Cloud Run execution still
 *    working when Scheduler fires the next one) never pick the same rows.
 *  - stamping `processing_started_at` means a row that was claimed but whose
 *    process died is invisible to other runs only until STALE_CLAIM_MS has
 *    passed, after which it becomes claimable again automatically.
 */
export async function claimPendingCompanies(limit: number): Promise<PendingCompany[]> {
  const client = await getPool();
  const staleSeconds = Math.max(1, Math.round(config.pipeline.staleClaimMs / 1000));

  const errorFilter = config.pipeline.retryErrored
    ? ''
    : `AND COALESCE(NULLIF(trim(metadata->>'errors'), ''), '') = ''`;

  const query = `
    UPDATE ${TABLE} AS t
       SET metadata   = t.metadata || jsonb_build_object('processing_started_at', to_jsonb(now())),
           updated_at = now()
      FROM (
            SELECT id
              FROM ${TABLE}
             WHERE ${NOT_CHECKED}
               AND COALESCE(NULLIF(trim(metadata->>'domain'), ''), NULLIF(trim(id), '')) IS NOT NULL
               ${errorFilter}
               AND (
                     metadata->>'processing_started_at' IS NULL
                  OR (metadata->>'processing_started_at')::timestamptz
                       < now() - make_interval(secs => $2::double precision)
                   )
             ORDER BY created_at ASC
             LIMIT $1
               FOR UPDATE SKIP LOCKED
           ) AS c
     WHERE t.id = c.id
 RETURNING t.id, t.metadata;
  `;

  const { rows } = await client.query<{ id: string; metadata: CompanyMetadata }>(query, [
    limit,
    staleSeconds,
  ]);

  
  return rows.map((row) => ({
    id: row.id,
    domain: String(row.metadata?.domain ?? row.id).trim(),
    metadata: row.metadata ?? {},
  }));
}

/* ------------------------------------------------------------------ */
/* Writing results back                                                */
/* ------------------------------------------------------------------ */

/**
 * Merges a partial metadata patch into the row's JSONB and accumulates token
 * counters on top of whatever was already there.
 *
 * Everything is a JSONB merge (`||`), never a replace, so the keys this
 * pipeline knows nothing about - record_id, row_number, created_by,
 * last_interaction_with, industry_thesis - survive untouched.
 *
 * Token counters are additive: a row reprocessed after an error shows total
 * spend across attempts, which is what you want when the point is tracking
 * cost. `last_run_usage` keeps the most recent call's breakdown on its own.
 */
export async function finishCompany(
  id: string,
  patch: Partial<CompanyMetadata>,
  usage?: TokenUsage
): Promise<void> {
  const client = await getPool();

  const query = `
    UPDATE ${TABLE} AS t
       SET metadata = (
             t.metadata
             || $2::jsonb
             || jsonb_build_object(
                  'input_tokens',
                    COALESCE(NULLIF(t.metadata->>'input_tokens','')::numeric, 0) + $3::numeric,
                  'output_tokens',
                    COALESCE(NULLIF(t.metadata->>'output_tokens','')::numeric, 0) + $4::numeric,
                  'cache_read_input_tokens',
                    COALESCE(NULLIF(t.metadata->>'cache_read_input_tokens','')::numeric, 0) + $5::numeric,
                  'cache_creation_input_tokens',
                    COALESCE(NULLIF(t.metadata->>'cache_creation_input_tokens','')::numeric, 0) + $6::numeric,
                  'last_run_usage', $7::jsonb
                )
           ) - 'processing_started_at',
           updated_at = now()
     WHERE t.id = $1;
  `;

  await client.query(query, [
    id,
    JSON.stringify(patch),
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cache_creation_input_tokens ?? 0,
    usage ? JSON.stringify(usage) : null,
  ]);
}

/** Clears the claim stamp without recording a result (used on shutdown). */
export async function releaseCompany(id: string): Promise<void> {
  const client = await getPool();
  await client.query(
    `UPDATE ${TABLE} SET metadata = metadata - 'processing_started_at', updated_at = now() WHERE id = $1`,
    [id]
  );
}

/** Totals for the whole table, printed at the end of each run. */
export async function tokenTotals(): Promise<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> {
  const client = await getPool();
  const { rows } = await client.query<{
    input: string | null;
    output: string | null;
    cache_read: string | null;
    cache_write: string | null;
  }>(`
    SELECT sum(COALESCE(NULLIF(metadata->>'input_tokens','')::numeric, 0))::text  AS input,
           sum(COALESCE(NULLIF(metadata->>'output_tokens','')::numeric, 0))::text AS output,
           sum(COALESCE(NULLIF(metadata->>'cache_read_input_tokens','')::numeric, 0))::text AS cache_read,
           sum(COALESCE(NULLIF(metadata->>'cache_creation_input_tokens','')::numeric, 0))::text AS cache_write
      FROM ${TABLE}
  `);
  const row = rows[0];
  return {
    input: Number(row?.input ?? 0),
    output: Number(row?.output ?? 0),
    cacheRead: Number(row?.cache_read ?? 0),
    cacheWrite: Number(row?.cache_write ?? 0),
  };
}

/** False once the SSH tunnel has reported an error; the run should stop. */
export function isTransportHealthy(): boolean {
  return !config.ssh.enabled || tunnelHealthy;
}

/** Cheap startup check so a bad DATABASE_URL fails loudly and immediately. */
export async function assertConnection(): Promise<void> {
  const client = await getPool();
  await client.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (tunnelServer) {
    tunnelServer.close();
    tunnelServer = null;
  }
  if (sshConnection) {
    sshConnection.end();
    sshConnection = null;
  }
}
