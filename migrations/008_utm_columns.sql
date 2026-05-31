-- UTM attribution columns on user_profiles
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS landing_page TEXT,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW();
