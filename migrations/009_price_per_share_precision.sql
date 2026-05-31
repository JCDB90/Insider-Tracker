-- Widen price_per_share from NUMERIC(10,2) to NUMERIC(18,6).
-- Required for sub-penny stocks (UK AIM, FR micro-caps) where the price
-- is < 0.01 GBP/EUR per share. The old type silently truncated these to 0.
--
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE insider_transactions
  ALTER COLUMN price_per_share TYPE NUMERIC(18, 6);
