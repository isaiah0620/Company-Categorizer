import 'dotenv/config';
import type { AppConfig } from './types.js';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: AppConfig = {
  google: {
    clientEmail: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: required('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    spreadsheetId: required('GOOGLE_SPREADSHEET_ID'),
    sheetName: required('GOOGLE_SHEET_NAME', 'Companies - Uncategorized'),
  },
  firecrawl: {
    apiKey: required('FIRECRAWL_API_KEY'),
    baseUrl: required('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev/v1'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: required('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
  },
  database: {
    connectionString: required('DATABASE_URL'),
    // Set DATABASE_SSL=true for hosted Postgres (Neon, Supabase, etc.).
    // Leave unset for local Postgres, Cloud SQL via the Cloud Run socket
    // connector, or when SSH_TUNNEL_ENABLED handles the transport instead.
    ssl: (process.env.DATABASE_SSL ?? 'false') === 'true',
  },
  ssh: {
    // Set true when Postgres is only reachable by SSHing into its VPS
    // first (i.e. the same thing the n8n Postgres node's "SSH Tunnel"
    // option does). DATABASE_URL should then use the host/port Postgres
    // listens on FROM THE VPS'S OWN PERSPECTIVE (usually 127.0.0.1:5432) -
    // the tunnel rewrites that to a local forwarded port at connection
    // time; the SSH host itself is configured separately below.
    enabled: (process.env.SSH_TUNNEL_ENABLED ?? 'false') === 'true',
    host: process.env.SSH_HOST,
    port: Number(process.env.SSH_PORT ?? 22),
    username: process.env.SSH_USERNAME,
    // Provide EITHER a private key (recommended) OR a password.
    privateKey: process.env.SSH_PRIVATE_KEY
      ? process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
    passphrase: process.env.SSH_PRIVATE_KEY_PASSPHRASE || undefined,
    password: process.env.SSH_PASSWORD || undefined,
  },
  pipeline: {
    batchSize: Number(process.env.BATCH_SIZE ?? 10),
    scrapeDelayMs: Number(process.env.SCRAPE_DELAY_MS ?? 20000),
    betweenCompanyDelayMs: Number(process.env.BETWEEN_COMPANY_DELAY_MS ?? 3000),
    scheduleCron: process.env.SCHEDULE_CRON ?? '*/15 * * * *',
    runOnStartup: (process.env.RUN_ON_STARTUP ?? 'true') === 'true',
  },
};
