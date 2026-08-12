-- General query-performance indexes for insider_transactions.
--
-- NOT an RLS fix: migration 020's SELECT policy is `USING (true)`, which is
-- a no-op filter with no real evaluation cost. These indexes just help the
-- ORDER BY transaction_date DESC / created_at DESC used by the frontend's
-- fetchAll() pagination loop (frontend/src/App.jsx), and general lookups.
--
-- NOT applied automatically — review and run manually in Supabase SQL
-- Editor: app.supabase.com → SQL Editor. (Same pattern as 019/020.)

CREATE INDEX IF NOT EXISTS idx_transactions_date
ON insider_transactions(transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_created
ON insider_transactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_country
ON insider_transactions(country_code);
