-- Prevent duplicate transactions from different scraper runs.
--
-- Two rows with the same (country, company, insider, date, type, price) cannot
-- represent different real trades — they are parsing artifacts where the share
-- count was wrong in one run. This constraint makes re-scrapes idempotent:
-- inserting with a correct share count will hit onConflict and be ignored
-- (or upsert) instead of creating a second row.
--
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor
-- (Prerequisite: run the duplicate cleanup in migrations/013 first if any remain)

DROP INDEX IF EXISTS idx_no_duplicate_transactions;

CREATE UNIQUE INDEX idx_no_duplicate_transactions
ON insider_transactions (
  country_code,
  company,
  insider_name,
  transaction_date,
  transaction_type,
  price_per_share
)
WHERE insider_name IS NOT NULL
AND price_per_share > 0;
