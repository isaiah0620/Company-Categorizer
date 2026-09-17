import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import type { Server } from 'net';
import { config } from './config.js';
import type { CompanyMetadataRecord } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let tunnelServer: Server | null = null;
let sshConnection: { end: () => void } | null = null;

/**
 * Opens the SSH tunnel (equivalent of n8n's Postgres node "SSH Tunnel"
 * option) and returns a rewritten connection string that points at the
 * local forwarded port instead of the real DB host.
 */
async function openSshTunnel(connectionString: string): Promise<string> {
  const dbUrl = new URL(connectionString);
  const dstAddr = dbUrl.hostname;
  const dstPort = Number(dbUrl.port || 5432);

  const sshOptions: Record<string, unknown> = {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
  };

  if (config.ssh.privateKey) {
    sshOptions.privateKey = config.ssh.privateKey;
    if (config.ssh.passphrase) sshOptions.passphrase = config.ssh.passphrase;
  } else if (config.ssh.password) {
    sshOptions.password = config.ssh.password;
  } else {
    throw new Error(
      'SSH_TUNNEL_ENABLED is true but neither SSH_PRIVATE_KEY nor SSH_PASSWORD is set'
    );
  }

  const [server, connection] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    { host: '127.0.0.1', port: 0 }, // port 0: let the OS pick a free local port
    sshOptions,
    { dstAddr, dstPort }
  );

  tunnelServer = server as Server;
  sshConnection = connection as { end: () => void };

  const localPort = (tunnelServer.address() as { port: number }).port;
  console.log(
    `[db] SSH tunnel up: 127.0.0.1:${localPort} -> ${config.ssh.host} -> ${dstAddr}:${dstPort}`
  );

  dbUrl.hostname = '127.0.0.1';
  dbUrl.port = String(localPort);
  return dbUrl.toString();
}

/**
 * Lazily builds the pg Pool. Lazy because opening an SSH tunnel is async,
 * and we want a clear error at first use rather than an unhandled promise
 * rejection at import time.
 */
async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;

  const connectionString = config.ssh.enabled
    ? await openSshTunnel(config.database.connectionString)
    : config.database.connectionString;

  pool = new Pool({
    connectionString,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  });

  return pool;
}

/**
 * Equivalent of the n8n "Insert or update rows in a table" node: upserts
 * into public.company_metadata keyed on domain, storing the full row as
 * JSONB metadata.
 */
export async function upsertCompanyMetadata(
  domain: string,
  metadata: CompanyMetadataRecord
): Promise<void> {
  const client = await getPool();
  const query = `
    INSERT INTO public.company_metadata (id, metadata, created_at, updated_at)
    VALUES ($1, $2, now(), now())
    ON CONFLICT (id)
    DO UPDATE SET metadata = $2, updated_at = now();
  `;
  await client.query(query, [domain, metadata]);
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
