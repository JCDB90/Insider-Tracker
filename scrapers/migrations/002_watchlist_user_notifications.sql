-- Migration 002: User-linked watchlists + notification tracking
-- Run in: Supabase Dashboard → SQL Editor
-- Purpose: enables personalized daily email alerts per user

-- 1. Add user_id to watchlist (null = demo/fallback row; set on user inserts)
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist(user_id);

-- 2. Extend user_profiles for notifications
--    (table already exists but may be empty — add missing columns)
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS id UUID PRIMARY KEY DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS last_notified_at DATE,
  ADD COLUMN IF NOT EXISTS notification_opt_in BOOLEAN DEFAULT TRUE;

-- 3. RLS: users can only see/edit their own profile row
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'own_profile'
  ) THEN
    CREATE POLICY own_profile ON user_profiles
      USING (id = auth.uid())
      WITH CHECK (id = auth.uid());
  END IF;
END $$;

-- 4. RLS on watchlist: users can only read/write their own rows
--    (service_role key in scraper bypasses RLS)
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'watchlist' AND policyname = 'own_watchlist'
  ) THEN
    CREATE POLICY own_watchlist ON watchlist
      USING (user_id = auth.uid() OR user_id IS NULL)
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- 5. Trigger: auto-create user_profiles row on auth.users insert
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('watchlist', 'user_profiles')
ORDER BY table_name, ordinal_position;
