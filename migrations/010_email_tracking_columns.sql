-- Email lifecycle tracking columns on user_profiles
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS welcome_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checkin_14d_sent_at TIMESTAMPTZ;
