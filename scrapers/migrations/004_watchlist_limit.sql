-- Migration 004: Enforce personal watchlist limit at the DB level
--
-- Context: the frontend already checks watchlistLimit (3 for free/visitor,
-- unlimited for pro/elite/admin) before calling supabase.from('watchlist').insert(),
-- but that check runs client-side — a user calling the Supabase client directly
-- (open devtools) bypasses it entirely, since RLS on `watchlist` only checks
-- `user_id = auth.uid()`, never the caller's plan. This adds a real DB-level
-- limit that can't be bypassed that way.
--
-- Note: user_profiles.plan's actual free-tier value is 'visitor' (there is no
-- literal 'free' string in the DB) — the function below treats anything OTHER
-- than pro/elite/admin as the 3-item limit, so it's correct regardless of
-- whether the free-tier value is 'visitor', 'free', or NULL.
--
-- Known limitation, accepted rather than engineered around: this is a simple
-- BEFORE INSERT count check, not a serializable transaction or advisory lock —
-- two concurrent inserts from the same user (e.g. two open tabs) could both
-- read the same current_count and both pass, letting the limit be exceeded by
-- one row in that race. Not worth the added complexity for a personal-watchlist
-- soft cap; revisit only if this is ever used to gate something with real
-- financial/security stakes.
--
-- Run in Supabase SQL Editor.

-- Function to check watchlist limit before insert
CREATE OR REPLACE FUNCTION check_watchlist_limit()
RETURNS TRIGGER AS $$
DECLARE
  user_plan TEXT;
  current_count INTEGER;
  max_allowed INTEGER;
BEGIN
  -- Get user plan
  SELECT plan INTO user_plan
  FROM user_profiles
  WHERE id = NEW.user_id;

  -- Set limit based on plan
  IF user_plan IN ('pro', 'elite', 'admin') THEN
    max_allowed := 999999; -- unlimited
  ELSE
    max_allowed := 3; -- free plan
  END IF;

  -- Count existing watchlist items
  SELECT COUNT(*) INTO current_count
  FROM watchlist
  WHERE user_id = NEW.user_id;

  -- Block if at limit
  IF current_count >= max_allowed THEN
    RAISE EXCEPTION 'Watchlist limit reached. Upgrade to Pro for unlimited watchlist stocks.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger
DROP TRIGGER IF EXISTS enforce_watchlist_limit ON watchlist;
CREATE TRIGGER enforce_watchlist_limit
  BEFORE INSERT ON watchlist
  FOR EACH ROW
  EXECUTE FUNCTION check_watchlist_limit();

-- Verify: trigger is attached
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE tgname = 'enforce_watchlist_limit';
