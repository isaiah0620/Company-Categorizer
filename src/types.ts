/**
 * Shared domain types for the company-categorizer pipeline.
 */

export interface GoogleConfig {
  enabled: boolean;
  clientEmail?: string;
  privateKey?: string;
  spreadsheetId?: string;
  sheetName: string;
}

export interface FirecrawlConfig {
  apiKey?: string;
  baseUrl: string;
  /** Requests per minute we allow ourselves to send. */
  rpm: number;
  /** Max simultaneous in-flight requests. */
  concurrency: number;
  timeoutMs: number;
}

export interface TavilyConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  extractDepth: 'basic' | 'advanced';
  rpm: number;
  concurrency: number;
  timeoutMs: number;
}

export type ScrapeProvider = 'firecrawl' | 'tavily';

export interface ScraperConfig {
  /** Which provider to try first. */
  primary: ScrapeProvider;
  /** Provider to fall back to when the primary fails, or null to disable. */
  fallback: ScrapeProvider | null;
}

export interface AnthropicConfig {
  /** Optional at the type level because it's only required when LLM_PROVIDER=anthropic; see validateConfig(). */
  apiKey?: string;
  model: string;
  maxTokens: number;
  /** Prompt-cache TTL. '5m' is free to refresh; '1h' costs 2x on writes. */
  cacheTtl: '5m' | '1h';
  cacheEnabled: boolean;
  /** Fire a max_tokens:0 warm-up call before fanning out in parallel. */
  prewarmCache: boolean;
  rpm: number;
  concurrency: number;
}

/** Which LLM backend the pipeline calls for name-screening and categorization. */
export type LlmProvider = 'anthropic' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
}

export interface OpenAiConfig {
  /** Optional at the type level because it's only required when LLM_PROVIDER=openai; see validateConfig(). */
  apiKey?: string;
  model: string;
  maxTokens: number;
  rpm: number;
  concurrency: number;
}

export interface DatabaseConfig {
  connectionString: string;
  ssl: boolean;
  table: string;
  poolMax: number;
}

export interface SshConfig {
  enabled: boolean;
  host?: string;
  port: number;
  username?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  readyTimeoutMs: number;
  /** SHA256 host key fingerprint, required when using password auth (no key pair to protect the tunnel otherwise). */
  hostFingerprint?: string;
}

export interface NameScreenConfig {
  /** Run the name/domain pre-screen before any scrape or categorization. */
  enabled: boolean;
  /**
   * Minimum self-reported confidence (0-1) for a "target" verdict to skip the
   * scrape + categorization. Anything below this continues down the full path.
   */
  minConfidence: number;
  maxTokens: number;
}

export interface PipelineConfig {
  batchSize: number;
  /** How many companies are processed at the same time. */
  concurrency: number;
  /** Rows claimed but never finished are re-claimable after this long. */
  staleClaimMs: number;
  /** Re-attempt rows that already have an `errors` value. */
  retryErrored: boolean;
  /** Max retry attempts for a transient (429/5xx/network) failure. */
  maxRetries: number;
  scheduleCron: string;
  runOnStartup: boolean;
  /** Also mirror results back into the Google Sheet. Off by default now. */
  sheetWriteback: boolean;
}

export interface AppConfig {
  google: GoogleConfig;
  firecrawl: FirecrawlConfig;
  tavily: TavilyConfig;
  scraper: ScraperConfig;
  llm: LlmConfig;
  anthropic: AnthropicConfig;
  openai: OpenAiConfig;
  nameScreen: NameScreenConfig;
  database: DatabaseConfig;
  ssh: SshConfig;
  pipeline: PipelineConfig;
}

/* ------------------------------------------------------------------ */
/* Database records                                                    */
/* ------------------------------------------------------------------ */

/**
 * The JSONB payload stored in company_metadata.metadata. Only the keys the
 * pipeline reads or writes are typed; everything else the row already
 * carries (record_id, row_number, last_interaction_*, ...) is preserved
 * untouched because every write is a JSONB merge, never a replace.
 */
export interface CompanyMetadata {
  name?: string | null;
  domain?: string | null;
  note?: string | null;
  errors?: string | null;
  checked?: boolean | string | null;
  category?: string | null;
  sub_category?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  checked_at?: string | null;
  processing_started_at?: string | null;
  last_run_usage?: TokenUsage | null;
  /** How the category was decided: from the name alone, or from scraped content. */
  classification_source?: 'name_screen' | 'scrape' | null;
  /** Audit trail of the name/domain pre-screen, kept even when it fell through. */
  name_screen?: NameScreenRecord | null;
  [key: string]: unknown;
}

/** A row claimed from the database for processing. */
export interface PendingCompany {
  id: string;
  domain: string;
  metadata: CompanyMetadata;
}

/** Token counters for a single Claude call. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model?: string;
  at?: string;
}

export const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/* ------------------------------------------------------------------ */
/* Name screening                                                      */
/* ------------------------------------------------------------------ */

/**
 * "target"     - name/domain make it clear this is an operating business.
 * "not_target" - name/domain point at a financial / advisory / deal-community firm.
 * "unsure"     - the name alone can't settle it.
 *
 * Only a confident "target" short-circuits the pipeline; the other two both
 * continue on to scrape + categorize.
 */
export type NameScreenVerdict = 'target' | 'not_target' | 'unsure';

export interface NameScreenResult {
  verdict: NameScreenVerdict;
  /** 0-1, as reported by the model. */
  confidence: number;
  reason: string;
}

export interface NameScreenOutcome {
  result: NameScreenResult;
  usage: TokenUsage;
  /** True when the verdict is "target" and confidence clears the threshold. */
  isConfidentTarget: boolean;
}

/** What gets persisted under metadata.name_screen. */
export interface NameScreenRecord extends NameScreenResult {
  /** True when this verdict is why the scrape + categorization never ran. */
  skipped_scrape: boolean;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Scraping                                                            */
/* ------------------------------------------------------------------ */

export interface ScrapeResult {
  markdown: string;
  statusCode?: number;
  sourceUrl?: string;
  provider: ScrapeProvider;
}

export interface FirecrawlScrapeMetadata {
  statusCode?: number;
  sourceURL?: string;
  error?: string;
  [key: string]: unknown;
}

export interface FirecrawlScrapeData {
  markdown?: string;
  metadata?: FirecrawlScrapeMetadata;
}

export interface FirecrawlScrapeResponse {
  data?: FirecrawlScrapeData;
}

export interface FirecrawlMapResponse {
  links?: string[];
  [key: string]: unknown;
}

export interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
  [key: string]: unknown;
}

export interface TavilyFailedResult {
  url?: string;
  error?: string;
}

export interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: TavilyFailedResult[];
  response_time?: number;
}

/* ------------------------------------------------------------------ */
/* Categorization                                                      */
/* ------------------------------------------------------------------ */

/** One category assignment returned by Claude for a company. */
export interface CategoryAssignment {
  category: string;
  subcategories: string[];
  note: string;
}

/** Raw structured output parsed from Claude's response. */
export interface CategorizationResult {
  companyName: string;
  categories: CategoryAssignment[];
}

/** Categorization plus the token counters the call consumed. */
export interface CategorizationOutcome {
  result: CategorizationResult;
  usage: TokenUsage;
}

/** Flattened Category / Sub Category / Note values. */
export interface CombinedCategorization {
  companyName: string;
  combinedCategory: string;
  combinedSubcategory: string;
  combinedNote: string;
}

/** Fields that can be written back to a sheet row via updateRowByDomain. */
export type SheetUpdateFields = Partial<
  Record<'Category' | 'Sub Category' | 'Note' | 'Checked' | 'Errors', string>
>;

/** A row read back from the Google Sheet, keyed by header name. */
export interface SheetRow {
  __rowNumber: number;
  Domains?: string;
  Category?: string;
  'Sub Category'?: string;
  Note?: string;
  Checked?: string;
  Errors?: string;
  [column: string]: string | number | undefined;
}
