-- Block bot/disposable-email signups server-side, at the auth.users table
-- itself — not just in the frontend's isBlockedEmail() (frontend/src/App.jsx).
--
-- Root cause of "already-blocked domains still getting through" (2026-08-05):
-- the frontend check only runs inside the React app's own JS, before it calls
-- supabase.auth.signUp(). A bot that skips the browser and POSTs directly to
-- Supabase's public Auth REST API (POST /auth/v1/signup, using the anon key —
-- which is public, embedded in this project's own bundled JS) never executes
-- that check at all. guerrillamailblock.com and web-library.net were BOTH
-- already present in the frontend's BLOCKED_DOMAINS list before this
-- migration — the fix was never "add the missing domain", it was "enforce
-- this somewhere a bot can't skip". A BEFORE INSERT trigger on auth.users
-- runs inside Postgres itself, so it applies no matter how the row was
-- created: browser signup, direct REST call, magic link, or OAuth.
--
-- Keep this list in sync with frontend/src/App.jsx's BLOCKED_DOMAINS /
-- BLOCKED_PATTERNS — the frontend check stays useful as an immediate
-- in-browser error message (nicer UX, saves a round trip for the common
-- case), but THIS trigger is the actual enforcement layer now.
--
-- Known limitation, accepted rather than engineered around: a blocked signup
-- fails with whatever generic error GoTrue surfaces for an unhandled
-- Postgres exception (not a clean "please use a different email" message
-- like the frontend shows) — acceptable since real users essentially never
-- hit this path; only bots using disposable domains or bot-tool naming
-- conventions do. Also intentionally does NOT include a blanket
-- "N random lowercase letters" username-shape rule (see the frontend file
-- for why) — too many real people have plain dictionary-word local parts in
-- that same shape.
--
-- Run in Supabase SQL Editor: app.supabase.com → SQL Editor

CREATE OR REPLACE FUNCTION block_bot_signup_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  local_part TEXT := lower(split_part(NEW.email, '@', 1));
  domain_part TEXT := lower(split_part(NEW.email, '@', 2));
  blocked_domains TEXT[] := ARRAY[
    'mailinator.com', 'maildrop.cc', 'guerrillamail.com', 'guerrillamailblock.com',
    'tempmail.com', 'yopmail.com', 'throwam.com', 'sharklasers.com',
    'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
    'guerrillamail.net', 'guerrillamail.org', 'grr.la', 'spam4.me',
    'trashmail.com', 'trashmail.me', 'trashmail.net', 'dispostable.com',
    'example.com', 'example.org', 'example.net',
    'test.com', 'fake.com', 'invalid.com',
    'web-library.net', 'cursor.dev', 'emalupe.com'
  ];
BEGIN
  -- NULL email (e.g. some SSO flows) — nothing to check, let it through.
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  IF domain_part = ANY(blocked_domains) THEN
    RAISE EXCEPTION 'Signups from this email address are not allowed.';
  END IF;

  IF NEW.email ~* 'security[._-]review'
     OR NEW.email ~* 'security[0-9]+'
     OR NEW.email ~* 'test[._-][0-9]+'
     OR NEW.email ~ '[0-9]{10,}'
     OR NEW.email ~* 'appsec[.-]review'
     OR NEW.email ~* 'appsec[0-9]+'
     OR local_part ~* '^appsec'
     OR local_part ~* '^sec[.-]review'
     OR local_part ~* '^probe[0-9]+'
     OR local_part ~* '^test[0-9]{5,}'
     OR local_part ~* '^redir[.-]probe'
     OR local_part ~* '^secmeta[0-9]+'
     OR local_part ~* '^appscan[0-9]+'
  THEN
    RAISE EXCEPTION 'Signups from this email address are not allowed.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_block_bot_signup ON auth.users;
CREATE TRIGGER enforce_block_bot_signup
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION block_bot_signup_email();

-- Verify
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE trigger_name = 'enforce_block_bot_signup';
