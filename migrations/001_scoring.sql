-- ─────────────────────────────────────────────────────────────────────────────
-- InsidersAtlas — Scoring System V2
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add conviction scoring columns to insider_transactions
ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS conviction_score   DECIMAL(4,3);
ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS conviction_label   TEXT;
ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS price_30d_before   DECIMAL;
ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS price_return_30d   DECIMAL;

-- Index for fast querying of unscored rows
CREATE INDEX IF NOT EXISTS idx_it_conviction_null
  ON insider_transactions (conviction_score)
  WHERE conviction_score IS NULL;

-- 2. Insider performance tracking table
CREATE TABLE IF NOT EXISTS insider_performance (
  id               UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  insider_name     TEXT         NOT NULL,
  company          TEXT         NOT NULL,
  ticker           TEXT,
  country_code     TEXT,
  transaction_id   UUID         REFERENCES insider_transactions(id) ON DELETE CASCADE,
  transaction_date DATE,
  transaction_price DECIMAL,
  price_7d         DECIMAL,
  price_30d        DECIMAL,
  price_90d        DECIMAL,
  return_7d        DECIMAL,
  return_30d       DECIMAL,
  return_90d       DECIMAL,
  hit_rate_30d     BOOLEAN,
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_tx_id
  ON insider_performance (transaction_id);

CREATE INDEX IF NOT EXISTS idx_perf_insider
  ON insider_performance (insider_name);

CREATE INDEX IF NOT EXISTS idx_perf_ticker
  ON insider_performance (ticker);

-- 3. Personal watchlist
CREATE TABLE IF NOT EXISTS watchlist (
  id           UUID  DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker       TEXT  NOT NULL,
  company      TEXT  NOT NULL,
  country_code TEXT,
  yahoo_ticker TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ticker)
);

INSERT INTO watchlist (ticker, company, country_code, yahoo_ticker) VALUES
  ('VID',   'Vidrala',       'ES', 'VID.MC'),
  ('THEP',  'Thermador',     'FR', 'THEP.PA'),
  ('PRX',   'Prosus',        'NL', 'PRX.AS'),
  ('ASML',  'ASML',          'NL', 'ASML.AS'),
  ('FLOW',  'Flow Traders',  'NL', 'FLOW.AS'),
  ('JEN',   'Jensen Group',  'BE', 'JEN.BR')
ON CONFLICT (ticker) DO NOTHING;
