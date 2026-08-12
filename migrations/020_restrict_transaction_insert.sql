-- Restrict writes to insider_transactions to service_role only.
--
-- Independent motivation (verified in this repo, not just an unconfirmed
-- incident report): scrapers/lib/db.js falls back to a hardcoded Supabase
-- key (`sb_publishable_...`, i.e. the anon/publishable key) when
-- SUPABASE_KEY isn't set. That key is checked into git, so it's public.
-- If RLS isn't already restricting INSERT on this table, anyone with that
-- key can write arbitrary rows via the public REST API. This migration
-- closes that regardless of whether any specific bad rows were ever found.
--
-- ⚠ BEFORE RUNNING THIS: confirm the SUPABASE_KEY used by the real scrapers
-- in production (GitHub Actions secret) is the service_role key, not the
-- publishable/anon key. service_role bypasses RLS automatically; anon does
-- not. If production is actually running scrapers on the anon key, this
-- migration will silently break every scraper's writes the moment it's
-- applied — check that first.
--
-- NOT applied automatically — written but not run. Review, confirm the
-- service_role check above, and run manually in Supabase SQL Editor:
-- app.supabase.com → SQL Editor. (Same pattern as migration 019.)

ALTER TABLE insider_transactions ENABLE ROW LEVEL SECURITY;

-- Existing behavior: table is publicly readable, keep that.
CREATE POLICY "Anyone can read transactions"
ON insider_transactions FOR SELECT
USING (true);

-- INSERT policies are evaluated with WITH CHECK, not USING — a plain
-- USING(false) on an INSERT policy is not valid Postgres and silently
-- does the wrong thing if it were coerced. service_role bypasses RLS
-- entirely, so it never goes through this policy.
CREATE POLICY "Block anon/authenticated inserts"
ON insider_transactions FOR INSERT
TO anon, authenticated
WITH CHECK (false);

CREATE POLICY "Block anon/authenticated updates"
ON insider_transactions FOR UPDATE
TO anon, authenticated
USING (false);

CREATE POLICY "Block anon/authenticated deletes"
ON insider_transactions FOR DELETE
TO anon, authenticated
USING (false);

-- Verify
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'insider_transactions';
