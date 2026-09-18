-- Run this against an EXISTING company_metadata table (the one that already
-- holds your rows). It is additive and idempotent: no data is rewritten.

-- 1. Index the unprocessed rows so the claim query doesn't scan the table.
CREATE INDEX IF NOT EXISTS company_metadata_pending_idx
  ON public.company_metadata (created_at)
  WHERE COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE;

CREATE INDEX IF NOT EXISTS company_metadata_domain_idx
  ON public.company_metadata ((metadata->>'domain'));

-- 2. Spend-tracking view.
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

-- 3. OPTIONAL: clear stale claim stamps left by a process that was killed
--    mid-run. The pipeline already reclaims these after STALE_CLAIM_MS, so
--    this is only for forcing an immediate retry.
-- UPDATE public.company_metadata
--    SET metadata = metadata - 'processing_started_at'
--  WHERE metadata ? 'processing_started_at';

-- 4. OPTIONAL: reset a batch of rows to be reprocessed from scratch.
-- UPDATE public.company_metadata
--    SET metadata = metadata || '{"checked": null, "errors": null}'::jsonb
--  WHERE metadata->>'domain' IN ('example.com');
