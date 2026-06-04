-- Add column for tracking the day-2 founder email to free/visitor users
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS onboarding_2d_sent_at TIMESTAMPTZ;
