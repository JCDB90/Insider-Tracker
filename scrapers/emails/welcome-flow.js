'use strict';
/**
 * Welcome Email Flow
 *
 * Runs daily. Sends two lifecycle emails:
 *
 *   Email 1 — Welcome (all users, sent ~1h after signup)
 *   Email 2 — 14-day check-in (Pro/Elite subscribers only)
 *
 * Tracking columns (migration 010_email_tracking_columns.sql):
 *   user_profiles.welcome_sent_at      TIMESTAMPTZ
 *   user_profiles.checkin_14d_sent_at  TIMESTAMPTZ
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — reads all user_profiles
 *   RESEND_API_KEY                           — sends via Resend
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;

const FROM_EMAIL  = 'hello@insidersalpha.com';
const REPLY_TO    = 'jcdeboer@yahoo.com';
const APP_URL     = 'https://www.insidersalpha.com';

if (!SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Email sender ──────────────────────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn(`  ⚠  RESEND_API_KEY not set — skipping email to ${to}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, reply_to: REPLY_TO, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`  ❌ Resend error for ${to}: ${res.status} ${err}`);
    return false;
  }
  return true;
}

// ── Email templates ───────────────────────────────────────────────────────────

function welcomeHtml() {
  return `
<!DOCTYPE html>
<html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111318;line-height:1.7">
  <div style="margin-bottom:28px">
    <span style="font-weight:700;font-size:16px;letter-spacing:-0.02em">InsidersAlpha</span>
  </div>
  <p>Hi,</p>
  <p>Welcome to InsidersAlpha — you now have access to insider transaction data across 15 European and Asian markets.</p>
  <p>Here's how to get started:</p>
  <p style="margin:0 0 6px">→ Filter by your favourite market using the country sidebar</p>
  <p style="margin:0 0 6px">→ Click any company to see their full insider history</p>
  <p style="margin:0 0 6px">→ Add stocks to your watchlist for daily email alerts</p>
  <p style="margin-top:24px">If you have any questions, just reply to this email.</p>
  <p style="margin-top:24px">Best,<br>Jelle<br><span style="color:#6B7280">InsidersAlpha</span></p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #f0f0f0">
  <p style="font-size:11px;color:#9CA3AF"><a href="${APP_URL}" style="color:#9CA3AF">insidersalpha.com</a></p>
</body></html>`.trim();
}

function checkin14dHtml() {
  return `
<!DOCTYPE html>
<html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111318;line-height:1.7">
  <div style="margin-bottom:28px">
    <span style="font-weight:700;font-size:16px;letter-spacing:-0.02em">InsidersAlpha</span>
  </div>
  <p>Hi,</p>
  <p>It's been 2 weeks since you joined InsidersAlpha Pro.</p>
  <p>I'd love to hear how you're finding it — what's working well, what could be better, or any features you'd like to see.</p>
  <p>If you'd prefer, I'm also happy to jump on a quick 15-minute call to walk you through everything. Just reply to this email and we'll find a time.</p>
  <p style="margin-top:24px">Best,<br>Jelle<br><span style="color:#6B7280">InsidersAlpha</span></p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #f0f0f0">
  <p style="font-size:11px;color:#9CA3AF"><a href="${APP_URL}" style="color:#9CA3AF">insidersalpha.com</a></p>
</body></html>`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('📧  Welcome Flow — processing lifecycle emails');

  // Fetch all users with relevant columns
  const { data: users, error } = await sb
    .from('user_profiles')
    .select('id, email, plan, created_at, welcome_sent_at, checkin_14d_sent_at')
    .not('email', 'is', null);

  if (error) { console.error('❌ DB fetch error:', error.message); process.exit(1); }
  console.log(`  ${users.length} users loaded`);

  const now         = new Date();
  const oneHourAgo  = new Date(now - 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  let welcomeSent = 0, checkinSent = 0;

  for (const u of users) {
    if (!u.email) continue;

    // ── Email 1: Welcome (all users, after 1h, not yet sent) ──────────────────
    if (!u.welcome_sent_at && u.created_at < oneHourAgo) {
      const ok = await sendEmail(u.email, 'Welcome to InsidersAlpha 🎯', welcomeHtml());
      if (ok) {
        await sb.from('user_profiles').update({ welcome_sent_at: now.toISOString() }).eq('id', u.id);
        console.log(`  ✉  Welcome → ${u.email}`);
        welcomeSent++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // ── Email 2: 14-day check-in (Pro/Elite, after 14 days, not yet sent) ─────
    const isPaid = ['pro', 'elite'].includes(u.plan);
    if (isPaid && !u.checkin_14d_sent_at && u.created_at < fourteenDaysAgo) {
      const ok = await sendEmail(u.email, 'How are you finding InsidersAlpha?', checkin14dHtml());
      if (ok) {
        await sb.from('user_profiles').update({ checkin_14d_sent_at: now.toISOString() }).eq('id', u.id);
        console.log(`  ✉  14-day check-in → ${u.email} (${u.plan})`);
        checkinSent++;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`  ✅ Done — welcome: ${welcomeSent} sent, 14-day check-in: ${checkinSent} sent`);
}

run().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
