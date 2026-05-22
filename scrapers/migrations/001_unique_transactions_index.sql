-- Migration: unique index to prevent duplicate transactions
-- Run in: Supabase Dashboard → SQL Editor
-- Purpose: database-level safety net preventing duplicate rows regardless of
--          how the scraper generates filing_ids. Covers only rows where
--          insider_name is known and price > 0 (real market transactions).

CREATE UNIQUE INDEX IF NOT EXISTS idx_no_duplicate_transactions
ON insider_transactions (
  country_code,
  company,
  insider_name,
  transaction_date,
  transaction_type,
  price_per_share,
  total_value
)
WHERE insider_name IS NOT NULL
  AND price_per_share > 0;

-- Verify
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'insider_transactions'
  AND indexname = 'idx_no_duplicate_transactions';
