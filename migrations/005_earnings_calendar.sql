-- ─────────────────────────────────────────────────────────────────────────────
-- Earnings Calendar
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS earnings_calendar (
  ticker        TEXT    NOT NULL,
  country_code  TEXT,
  earnings_date DATE    NOT NULL,
  source        TEXT    DEFAULT 'yahoo',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ticker, earnings_date)
);

CREATE INDEX IF NOT EXISTS idx_earnings_ticker ON earnings_calendar (ticker);
CREATE INDEX IF NOT EXISTS idx_earnings_date   ON earnings_calendar (earnings_date);

-- RLS: allow read/write for all roles (data is non-sensitive)
ALTER TABLE earnings_calendar ENABLE ROW LEVEL SECURITY;
CREATE POLICY "earnings_calendar_all" ON earnings_calendar
  FOR ALL USING (true) WITH CHECK (true);
