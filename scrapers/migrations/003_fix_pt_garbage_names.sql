-- Migration 003: Remove Portugal insider transactions with garbage name artifacts
--
-- Root cause: portugal.js Format B name regex matched "With purchase instruction
-- transmitted on YYYY-MM-DD – HHhMM" from NOS PDFs as the insider name instead of
-- the actual person name.
--
-- Fix: DELETE affected rows. The portugal.js scraper (with the regex fix in place)
-- will re-insert them with correct names on the next run, since the CMVM portal
-- keeps the 30 most recent TRAN filings and these rows are within that window.
--
-- Run in Supabase SQL Editor.

DELETE FROM insider_transactions
WHERE country_code = 'PT'
AND (
  insider_name ILIKE '%instruction transmitted%'
  OR insider_name ILIKE '%purchase instruction%'
  OR insider_name ILIKE 'With purchase%'
  OR insider_name ILIKE 'With order%'
  OR insider_name ILIKE 'Following the%'
  OR insider_name ILIKE 'Pursuant%'
);

-- Verify: should return 0 rows after migration
SELECT id, insider_name, company, transaction_date
FROM insider_transactions
WHERE country_code = 'PT'
AND (
  insider_name ILIKE '%instruction%'
  OR insider_name ILIKE '%transmitted%'
  OR insider_name ILIKE 'With %'
);
