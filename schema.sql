-- company_metadata: one row per company, everything in a JSONB blob so new
-- fields can be added without a migration.
CREATE TABLE IF NOT EXISTS public.company_metadata (
  id TEXT PRIMARY KEY,
  metadata JSONB NOT NULL,
  -- Filled by the crawler: URLs Tavily Map found on the site (one per line), and the exact
  -- markdown text that was sent to the model.
  sitemap TEXT,
  scraped_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pipeline polls "everything where metadata->>'checked' is not true".
-- Without an index that is a sequential scan of the whole table on every run.
-- This partial index contains ONLY the unprocessed rows, so it shrinks as the
-- backlog is worked through and the claim query stays fast at any table size.
--
-- The predicate is the crash-proof form of `(metadata->>'checked')::boolean
-- IS NOT TRUE`: a direct ::boolean cast raises on any value that isn't
-- boolean-ish, which would abort a batch because of one bad row.
CREATE INDEX IF NOT EXISTS company_metadata_pending_idx
  ON public.company_metadata (created_at)
  WHERE COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE;

-- Used when looking a company up by domain rather than by id.
CREATE INDEX IF NOT EXISTS company_metadata_domain_idx
  ON public.company_metadata ((metadata->>'domain'));

-- Used by the HTTP API's "have we already researched this domain?" lookup,
-- which compares lower(metadata->>'domain'). The index above is on the
-- un-lowered value, so Postgres cannot use it for that comparison.
CREATE INDEX IF NOT EXISTS company_metadata_domain_lower_idx
  ON public.company_metadata ((lower(metadata->>'domain')));

-- Handy view for tracking spend without writing the COALESCE dance by hand.
CREATE OR REPLACE VIEW public.company_token_usage AS
SELECT
  id,
  metadata->>'domain'                                                       AS domain,
  metadata->>'category'                                                     AS category,
  COALESCE(NULLIF(metadata->>'input_tokens','')::numeric, 0)                AS input_tokens,
  COALESCE(NULLIF(metadata->>'output_tokens','')::numeric, 0)               AS output_tokens,
  COALESCE(NULLIF(metadata->>'cache_read_input_tokens','')::numeric, 0)     AS cache_read_input_tokens,
  COALESCE(NULLIF(metadata->>'cache_creation_input_tokens','')::numeric, 0) AS cache_creation_input_tokens,
  metadata->>'checked_at'                                                   AS checked_at,
  metadata->>'scrape_provider'                                              AS scrape_provider
FROM public.company_metadata;
