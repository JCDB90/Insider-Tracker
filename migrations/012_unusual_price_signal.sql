-- Add is_unusual_price flag for option exercises / grant transactions
-- whose transaction price is significantly below market (peer-median comparison).
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE insider_transactions
  ADD COLUMN IF NOT EXISTS is_unusual_price BOOLEAN DEFAULT FALSE;
