-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — Signal flag columns
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE insider_transactions
  ADD COLUMN IF NOT EXISTS is_cluster_buy     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_repetitive_buy  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_pre_earnings    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_price_dip       BOOLEAN DEFAULT FALSE;

-- Index for fast badge filtering in the frontend
CREATE INDEX IF NOT EXISTS idx_it_cluster_buy
  ON insider_transactions (is_cluster_buy)
  WHERE is_cluster_buy = TRUE;

CREATE INDEX IF NOT EXISTS idx_it_pre_earnings
  ON insider_transactions (is_pre_earnings)
  WHERE is_pre_earnings = TRUE;
