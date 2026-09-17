/**
 * Shared domain types for the company-categorizer pipeline.
 */

export interface GoogleConfig {
  clientEmail: string;
  privateKey: string;
  spreadsheetId: string;
  sheetName: string;
}

export interface FirecrawlConfig {
  apiKey: string;
  baseUrl: string;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export interface DatabaseConfig {
  connectionString: string;
  ssl: boolean;
}

export interface SshConfig {
  enabled: boolean;
  host?: string;
  port: number;
  username?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export interface PipelineConfig {
  batchSize: number;
  scrapeDelayMs: number;
  betweenCompanyDelayMs: number;
  scheduleCron: string;
  runOnStartup: boolean;
}

export interface AppConfig {
  google: GoogleConfig;
  firecrawl: FirecrawlConfig;
  anthropic: AnthropicConfig;
  database: DatabaseConfig;
  ssh: SshConfig;
  pipeline: PipelineConfig;
}

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

/** Fields that can be written back to a sheet row via updateRowByDomain. */
export type SheetUpdateFields = Partial<
  Record<'Category' | 'Sub Category' | 'Note' | 'Checked' | 'Errors', string>
>;

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

/** Flattened Category / Sub Category / Note columns the sheet expects. */
export interface CombinedCategorization {
  companyName: string;
  combinedCategory: string;
  combinedSubcategory: string;
  combinedNote: string;
}

export interface CompanyMetadataRecord {
  Domains: string;
  companyName: string;
  Category: string;
  'Sub Category': string;
  Note: string;
  Checked: string;
}
