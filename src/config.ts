import 'dotenv/config';
import type { AppConfig, LlmProvider, ScrapeProvider } from './types.js';

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function opt(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(name: string): string {
  const value = opt(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = opt(name);
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

function num(name: string, fallback: number): number {
  const value = opt(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${value}"`);
  }
  return parsed;
}

function pem(name: string): string | undefined {
  const value = opt(name);
  return value ? value.replace(/\\n/g, '\n') : undefined;
}

function provider(name: string, fallback: ScrapeProvider): ScrapeProvider {
  const value = str(name, fallback).toLowerCase();
  if (value !== 'firecrawl' && value !== 'tavily') {
    throw new Error(`${name} must be "firecrawl" or "tavily", got "${value}"`);
  }
  return value;
}

function llmProvider(name: string, fallback: LlmProvider): LlmProvider {
  const value = str(name, fallback).toLowerCase();
  if (value !== 'anthropic' && value !== 'openai') {
    throw new Error(`${name} must be "anthropic" or "openai", got "${value}"`);
  }
  return value;
}

const tavilyEnabled = bool('TAVILY_ENABLED', false);
const primaryProvider = provider('SCRAPE_PROVIDER', 'firecrawl');

// "none" disables the fallback. Default: once Tavily is switched on, whichever
// provider isn't primary rescues the domains the primary fails on.
const defaultFallback = tavilyEnabled
  ? primaryProvider === 'tavily'
    ? 'firecrawl'
    : 'tavily'
  : 'none';
const fallbackRaw = str('SCRAPE_FALLBACK_PROVIDER', defaultFallback).toLowerCase();
const fallbackProvider: ScrapeProvider | null =
  fallbackRaw === 'none' || fallbackRaw === ''
    ? null
    : provider('SCRAPE_FALLBACK_PROVIDER', defaultFallback === 'none' ? 'tavily' : defaultFallback);

const cacheTtlRaw = str('ANTHROPIC_CACHE_TTL', '5m').toLowerCase();
if (cacheTtlRaw !== '5m' && cacheTtlRaw !== '1h') {
  throw new Error(`ANTHROPIC_CACHE_TTL must be "5m" or "1h", got "${cacheTtlRaw}"`);
}

export const config: AppConfig = {
  google: {
    // Sheets is now optional: the pipeline reads from Postgres. Turn this on
    // only if you still want results mirrored into the old spreadsheet.
    enabled: bool('SHEET_WRITEBACK_ENABLED', false),
    clientEmail: opt('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: pem('GOOGLE_PRIVATE_KEY'),
    spreadsheetId: opt('GOOGLE_SPREADSHEET_ID'),
    sheetName: str('GOOGLE_SHEET_NAME', 'Companies - Uncategorized'),
  },
  firecrawl: {
    apiKey: opt('FIRECRAWL_API_KEY'),
    baseUrl: str('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev/v1'),
    rpm: num('FIRECRAWL_RPM', 20),
    concurrency: num('FIRECRAWL_CONCURRENCY', 4),
    timeoutMs: num('FIRECRAWL_TIMEOUT_MS', 120000),
  },
  tavily: {
    enabled: tavilyEnabled,
    apiKey: opt('TAVILY_API_KEY'),
    baseUrl: str('TAVILY_BASE_URL', 'https://api.tavily.com'),
    extractDepth: str('TAVILY_EXTRACT_DEPTH', 'basic') === 'advanced' ? 'advanced' : 'basic',
    rpm: num('TAVILY_RPM', 60),
    concurrency: num('TAVILY_CONCURRENCY', 4),
    timeoutMs: num('TAVILY_TIMEOUT_MS', 60000),
  },
  scraper: {
    primary: primaryProvider,
    fallback: fallbackProvider === primaryProvider ? null : fallbackProvider,
  },
  llm: {
    // Which backend name-screening and categorization calls go through.
    // Everything else in this file (name screen thresholds, retries,
    // pipeline concurrency) is provider-agnostic and applies either way.
    provider: llmProvider('LLM_PROVIDER', 'anthropic'),
  },
  anthropic: {
    // Not `required()` here: only enforced when LLM_PROVIDER=anthropic (the
    // default), so an OpenAI-only setup doesn't need this key at all. See
    // validateConfig() below for the actual enforcement.
    apiKey: opt('ANTHROPIC_API_KEY'),
    model: str('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    maxTokens: num('ANTHROPIC_MAX_TOKENS', 1500),
    cacheTtl: cacheTtlRaw,
    cacheEnabled: bool('ANTHROPIC_PROMPT_CACHE', true),
    prewarmCache: bool('ANTHROPIC_PREWARM_CACHE', true),
    rpm: num('ANTHROPIC_RPM', 40),
    concurrency: num('ANTHROPIC_CONCURRENCY', 4),
  },
  openai: {
    // Same deal as anthropic.apiKey above, but for LLM_PROVIDER=openai.
    apiKey: opt('OPENAI_API_KEY'),
    model: str('OPENAI_MODEL', 'gpt-4o-mini'),
    maxTokens: num('OPENAI_MAX_TOKENS', 1500),
    // OpenAI's own rate limits are typically much higher than Anthropic's
    // default tiers; adjust to your account's actual limits.
    rpm: num('OPENAI_RPM', 500),
    concurrency: num('OPENAI_CONCURRENCY', 8),
  },
  nameScreen: {
    // Cheap first pass on name + domain. A confident "target" is stored as-is
    // and never reaches Firecrawl/Tavily or the categorizer.
    enabled: bool('NAME_SCREEN_ENABLED', true),
    minConfidence: num('NAME_SCREEN_MIN_CONFIDENCE', 0.9),
    maxTokens: num('NAME_SCREEN_MAX_TOKENS', 250),
  },
  database: {
    connectionString: required('DATABASE_URL'),
    // Set DATABASE_SSL=true for hosted Postgres (Neon, Supabase, etc.).
    // Leave unset for local Postgres, Cloud SQL via the Cloud Run socket
    // connector, or when SSH_TUNNEL_ENABLED handles the transport instead.
    ssl: bool('DATABASE_SSL', false),
    table: str('DATABASE_TABLE', 'public.gpt_luna_company_metadata'),
    // One connection per worker plus a spare for the claim query. Through an
    // SSH tunnel every connection is a separate forwarded channel, so this is
    // the knob to turn down if the bastion limits them.
    poolMax: num('DATABASE_POOL_MAX', Math.max(2, num('PIPELINE_CONCURRENCY', 4) + 1)),
  },
  ssh: {
    // Set true when Postgres is only reachable by SSHing into its VPS first.
    enabled: bool('SSH_TUNNEL_ENABLED', false),
    host: opt('SSH_HOST'),
    port: num('SSH_PORT', 22),
    username: opt('SSH_USERNAME'),
    privateKey: pem('SSH_PRIVATE_KEY'),
    passphrase: opt('SSH_PRIVATE_KEY_PASSPHRASE'),
    password: opt('SSH_PASSWORD'),
    readyTimeoutMs: num('SSH_READY_TIMEOUT_MS', 20000),
    hostFingerprint: opt('SSH_HOST_FINGERPRINT'),
  },
  pipeline: {
    batchSize: num('BATCH_SIZE', 25),
    concurrency: num('PIPELINE_CONCURRENCY', 4),
    staleClaimMs: num('STALE_CLAIM_MS', 15 * 60 * 1000),
    retryErrored: bool('RETRY_ERRORED', false),
    maxRetries: num('MAX_RETRIES', 5),
    scheduleCron: str('SCHEDULE_CRON', '*/15 * * * *'),
    runOnStartup: bool('RUN_ON_STARTUP', true),
    sheetWriteback: bool('SHEET_WRITEBACK_ENABLED', false),
  },
};

/**
 * Fails fast at startup with a readable message instead of blowing up
 * halfway through a batch because a provider was switched on without
 * its API key.
 */
export function validateConfig(): void {
  const problems: string[] = [];
  const usesFirecrawl =
    config.scraper.primary === 'firecrawl' || config.scraper.fallback === 'firecrawl';
  const usesTavily = config.scraper.primary === 'tavily' || config.scraper.fallback === 'tavily';

  if (usesFirecrawl && !config.firecrawl.apiKey) {
    problems.push('FIRECRAWL_API_KEY is required when Firecrawl is the primary or fallback scraper');
  }
  if (usesTavily) {
    if (!config.tavily.enabled) {
      problems.push(
        'Tavily is selected as a scraper but TAVILY_ENABLED is not true - set TAVILY_ENABLED=true'
      );
    }
    if (!config.tavily.apiKey) {
      problems.push('TAVILY_API_KEY is required when Tavily is the primary or fallback scraper');
    }
  }
  if (config.llm.provider === 'anthropic' && !config.anthropic.apiKey) {
    problems.push(
      'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic (the default) - set it, or set LLM_PROVIDER=openai instead'
    );
  }
  if (config.llm.provider === 'openai' && !config.openai.apiKey) {
    problems.push('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  }

  if (config.pipeline.sheetWriteback) {
    if (!config.google.clientEmail || !config.google.privateKey || !config.google.spreadsheetId) {
      problems.push(
        'SHEET_WRITEBACK_ENABLED=true requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and GOOGLE_SPREADSHEET_ID'
      );
    }
  }
  if (config.ssh.enabled && !config.ssh.privateKey && !config.ssh.password) {
    problems.push('SSH_TUNNEL_ENABLED=true requires either SSH_PRIVATE_KEY or SSH_PASSWORD');
  }

  if (config.nameScreen.minConfidence < 0 || config.nameScreen.minConfidence > 1) {
    problems.push('NAME_SCREEN_MIN_CONFIDENCE must be between 0 and 1');
  }

  if (config.pipeline.concurrency < 1) {
    problems.push('PIPELINE_CONCURRENCY must be at least 1');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
