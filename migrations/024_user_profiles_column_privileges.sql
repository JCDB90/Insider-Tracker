-- Stop signed-in users from changing their own plan.
--
-- user_profiles RLS lets a user write their own row with no column limits:
-- "Users can update own profile" (migrations/004, FOR UPDATE) and own_profile
-- (scrapers/migrations/002, FOR ALL). With the public anon key and their own
-- JWT, any user can PATCH /rest/v1/user_profiles?id=eq.<self> with
-- {"plan":"elite"} — or "admin", which frontend/api/admin-*.js trust for
-- access to every user's data and to setting anyone's plan.
--
-- RLS decides WHICH rows; column privileges decide WHICH columns. The app
-- only ever writes attribution columns from the browser (App.jsx
-- fetchUserPlan); plan, Stripe and email-tracking columns are written
-- server-side with the service role, which these grants don't affect.
--
-- Run in Supabase SQL Editor.

REVOKE INSERT, UPDATE, DELETE ON user_profiles FROM anon, authenticated;

GRANT UPDATE (landing_page, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
  ON user_profiles TO authenticated;

-- Fallback insert in fetchUserPlan (the on_auth_user_created trigger normally
-- creates the row first). plan is not grantable, so it takes its 'visitor' default.
GRANT INSERT (id, email, landing_page, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
  ON user_profiles TO authenticated;
