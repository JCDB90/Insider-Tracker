-- Migration 007 — Ticker metadata cache (sector/industry from Yahoo Finance)

CREATE TABLE IF NOT EXISTS ticker_metadata (
  ticker       TEXT NOT NULL,
  country_code TEXT NOT NULL,
  yahoo_symbol TEXT,
  sector       TEXT,
  industry     TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ticker, country_code)
);

CREATE INDEX IF NOT EXISTS idx_ticker_metadata_sector
  ON ticker_metadata (sector);

ALTER TABLE ticker_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ticker_metadata_read" ON ticker_metadata
  FOR SELECT USING (true);
