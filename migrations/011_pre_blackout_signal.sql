-- Replace is_pre_earnings with is_pre_blackout_buy
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE insider_transactions
  ADD COLUMN IF NOT EXISTS is_pre_blackout_buy BOOLEAN DEFAULT FALSE;

-- Clear the old pre_earnings flags (signal replaced by is_pre_blackout_buy)
UPDATE insider_transactions SET is_pre_earnings = FALSE;
