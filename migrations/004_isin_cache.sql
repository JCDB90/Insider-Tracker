-- Persistent ISIN → ticker cache.
-- Prevents repeated Yahoo Finance lookups for the same ISIN across scraper runs,
-- and survives rate-limiting that would otherwise lose resolutions.
CREATE TABLE IF NOT EXISTS isin_ticker_cache (
  isin         TEXT    NOT NULL,
  country_code TEXT    NOT NULL DEFAULT '',
  ticker       TEXT,                        -- NULL means definitively not found
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (isin, country_code)
);

CREATE INDEX IF NOT EXISTS isin_ticker_cache_ticker_idx ON isin_ticker_cache (ticker) WHERE ticker IS NOT NULL;
