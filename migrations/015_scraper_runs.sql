-- Scraper run log — tracks when each market scraper last executed,
-- regardless of whether it saved new rows.
-- Used by daily-health-check.js to detect genuinely missed runs vs
-- markets that ran but found no new filings.
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

CREATE TABLE IF NOT EXISTS scraper_runs (
  id          SERIAL PRIMARY KEY,
  country_code TEXT NOT NULL,
  ran_at      TIMESTAMPTZ DEFAULT NOW(),
  rows_saved  INTEGER DEFAULT 0,
  duration_s  NUMERIC(8,1),
  status      TEXT DEFAULT 'success'   -- 'success' | 'failed' | 'timeout'
);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_cc_ran
  ON scraper_runs (country_code, ran_at DESC);
