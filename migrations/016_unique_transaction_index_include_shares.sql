-- Extend idx_no_duplicate_transactions (013) to also include `shares`.
--
-- Discovered while backfilling insider_name for corporate-entity filings whose
-- real PDMR name is only found once (e.g. Spain/CNMV NYESA VALORES CORPORACIÓN
-- filings via "NEM BOM VENTO NEM BOM CASAMENTO S.L." / Liberto Campillo Molina):
-- multi-execution VWAP-style filings routinely produce several rows sharing the
-- exact same (country, company, insider_name, transaction_date, transaction_type,
-- price_per_share) — same person, same day, same price, but genuinely different
-- share counts per execution block. These rows could only exist un-named in the
-- first place because the current index has `WHERE insider_name IS NOT NULL`,
-- exempting them; backfilling the real name onto more than one such row per day
-- then collides with this index (14 of 25 backfill attempts failed with
-- "duplicate key value violates unique constraint idx_no_duplicate_transactions"
-- on 2026-07-21 despite every row being a real, distinct transaction).
--
-- Adding `shares` still catches genuine duplicate re-scrapes (an exact
-- re-insertion of the same parsed row has an identical share count too) while
-- no longer blocking legitimate distinct same-day/same-price executions.
--
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor
-- After applying, re-run the Spain NEM BOM VENTO backfill for the 14 rows that
-- were skipped (see git history / conversation for the exact ids, or just
-- re-run: UPDATE insider_transactions SET insider_name = 'Liberto Campillo Molina'
-- WHERE via_entity ILIKE '%nem bom%' AND insider_name IS NULL;)

DROP INDEX IF EXISTS idx_no_duplicate_transactions;

CREATE UNIQUE INDEX idx_no_duplicate_transactions
ON insider_transactions (
  country_code,
  company,
  insider_name,
  transaction_date,
  transaction_type,
  price_per_share,
  shares
)
WHERE insider_name IS NOT NULL
AND price_per_share > 0;
