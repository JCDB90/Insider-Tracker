-- Watchlist uniqueness per user, not per ticker.
--
-- migrations/001 created watchlist with a table-wide UNIQUE (ticker), from
-- before watchlists had a user_id. If that constraint is still live, a second
-- user can never watch a stock someone else already watches — the insert fails
-- with 23505 (the app now shows "We couldn't add X to your watchlist just
-- now" for it). The 15 live rows on 2026-11-06 had 15 distinct tickers across
-- 4 users, consistent with the constraint still being there.
--
-- Run in Supabase SQL Editor. Check first:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conrelid = 'public.watchlist'::regclass;

ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_ticker_key;

-- One row per user per listing; demo rows (user_id IS NULL) are unaffected
-- because NULLs never conflict in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_user_ticker_country_key
  ON watchlist (user_id, ticker, country_code);
