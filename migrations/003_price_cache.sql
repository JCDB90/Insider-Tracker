-- Persistent price cache: stores fetched closing prices to avoid re-fetching
-- and to retain prices for delisted/temporarily unavailable tickers.
CREATE TABLE IF NOT EXISTS price_cache (
  ticker     TEXT    NOT NULL,
  price_date DATE    NOT NULL,
  close_price DECIMAL(14,4) NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'yahoo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, price_date)
);

CREATE INDEX IF NOT EXISTS price_cache_ticker_idx ON price_cache (ticker);

-- Track tickers that consistently fail all sources (avoid retry storms)
CREATE TABLE IF NOT EXISTS ticker_dead_list (
  ticker       TEXT PRIMARY KEY,
  country_code TEXT,
  reason       TEXT,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
