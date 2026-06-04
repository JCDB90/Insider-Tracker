'use strict';
/**
 * Lifecycle Email Flow
 *
 * Email 1 — Welcome (Pro/Elite only, ~1h after signup)
 *   From: hello@insidersalpha.com
 *   Tracking: welcome_sent_at
 *
 * Email 2 — Founder check-in (Free/visitor only, day 2)
 *   From: jelle@insidersalpha.com  (personal tone)
 *   Tracking: onboarding_2d_sent_at
 *
 * Email 3 — 14-day check-in (Pro/Elite only, day 14)
 *   From: jelle@insidersalpha.com  (personal tone)
 *   Tracking: checkin_14d_sent_at
 *
 * DB columns required (migration 010 + 011):
 *   welcome_sent_at, checkin_14d_sent_at, onboarding_2d_sent_at
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const APP_URL          = 'https://www.insidersalpha.com';

if (!SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Email sender ──────────────────────────────────────────────────────────────

async function sendEmail(to, from, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn(`  ⚠  RESEND_API_KEY not set — skipping email to ${to}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from, reply_to: 'jcdeboer@yahoo.com', to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`  ❌ Resend error for ${to}: ${res.status} ${err}`);
    return false;
  }
  return true;
}

// ── Email templates ───────────────────────────────────────────────────────────

function wrap(body) {
  return `<!DOCTYPE html><html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111318;line-height:1.7">
${body}
<hr style="margin:32px 0;border:none;border-top:1px solid #f0f0f0">
<p style="font-size:11px;color:#9CA3AF"><a href="${APP_URL}" style="color:#9CA3AF">insidersalpha.com</a></p>
</body></html>`;
}

function welcomeHtml() {
  return wrap(`
  <div style="margin-bottom:28px"><span style="font-weight:700;font-size:16px;letter-spacing:-0.02em">InsidersAlpha</span></div>
  <p>Hi,</p>
  <p>Welcome to InsidersAlpha — you now have access to insider transaction data across 15 European and Asian markets.</p>
  <p>Here's how to get started:<br>
  → Filter by your favourite market using the country sidebar<br>
  → Click any company to see their full insider history<br>
  → Add stocks to your watchlist for daily email alerts</p>
  <p>If you have any questions, just reply to this email.</p>
  <p>Best,<br>Jelle<br><span style="color:#6B7280">InsidersAlpha</span></p>`);
}

function founderHtml() {
  return wrap(`
  <p>Hi,</p>
  <p>First of all, thank you for giving the platform a try.</p>
  <p>I originally built InsidersAlpha because I was struggling to track insider buying across Europe and South Korea myself. What started as a personal research tool has slowly grown into something other investors are finding useful as well.</p>
  <p>I'm constantly improving the platform and would genuinely love to hear:</p>
  <ul>
  <li>What do you find most useful?</li>
  <li>What's missing?</li>
  <li>What would make it indispensable for your investment process?</li>
  </ul>
  <p>No sales pitch — I'm simply trying to build the best insider-tracking platform possible.</p>
  <p>Kind regards,<br>Jelle de Boer<br>Founder — InsidersAlpha<br><a href="${APP_URL}">${APP_URL.replace('https://', '')}</a></p>`);
}

function checkin14dHtml() {
  return wrap(`
  <p>Hi,</p>
  <p>It's been 2 weeks since you joined InsidersAlpha Pro.</p>
  <p>I'd love to hear how you're finding it — what's working well, what could be better, or any features you'd like to see.</p>
  <p>If you'd prefer, I'm also happy to jump on a quick 15-minute call to walk you through everything. Just reply to this email and we'll find a time.</p>
  <p>Best,<br>Jelle<br><span style="color:#6B7280">InsidersAlpha</span></p>`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('📧  Lifecycle Email Flow');

  const now            = new Date();
  const oneHourAgo     = new Date(now - 1 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo     = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  let sent = { welcome: 0, founder: 0, checkin: 0 };

  // ── Email 1: Welcome — Pro/Elite only, ~1h after signup ───────────────────
  const { data: newPaid } = await sb.from('user_profiles')
    .select('id, email, plan')
    .in('plan', ['pro', 'elite'])
    .is('welcome_sent_at', null)
    .lte('created_at', oneHourAgo)
    .not('email', 'is', null);

  for (const u of newPaid || []) {
    const ok = await sendEmail(u.email, 'InsidersAlpha <hello@insidersalpha.com>',
      'Welcome to InsidersAlpha 🎯', welcomeHtml());
    if (ok) {
      await sb.from('user_profiles').update({ welcome_sent_at: now.toISOString() }).eq('id', u.id);
      console.log(`  ✉  Welcome (paid) → ${u.email}`);
      sent.welcome++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Email 2: Founder check-in — Free/visitor only, day 2 ─────────────────
  const { data: freeUsers } = await sb.from('user_profiles')
    .select('id, email, plan')
    .eq('plan', 'visitor')
    .is('onboarding_2d_sent_at', null)
    .lte('created_at', twoDaysAgo)
    .not('email', 'is', null);

  for (const u of freeUsers || []) {
    const ok = await sendEmail(u.email, 'Jelle de Boer <jelle@insidersalpha.com>',
      'Quick question about InsidersAlpha', founderHtml());
    if (ok) {
      await sb.from('user_profiles').update({ onboarding_2d_sent_at: now.toISOString() }).eq('id', u.id);
      console.log(`  ✉  Founder 2d → ${u.email}`);
      sent.founder++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Email 3: 14-day check-in — Pro/Elite only ─────────────────────────────
  const { data: proUsers } = await sb.from('user_profiles')
    .select('id, email, plan')
    .in('plan', ['pro', 'elite'])
    .is('checkin_14d_sent_at', null)
    .lte('created_at', fourteenDaysAgo)
    .not('email', 'is', null);

  for (const u of proUsers || []) {
    const ok = await sendEmail(u.email, 'Jelle de Boer <jelle@insidersalpha.com>',
      'How are you finding InsidersAlpha?', checkin14dHtml());
    if (ok) {
      await sb.from('user_profiles').update({ checkin_14d_sent_at: now.toISOString() }).eq('id', u.id);
      console.log(`  ✉  14-day check-in → ${u.email} (${u.plan})`);
      sent.checkin++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  ✅ Done — welcome: ${sent.welcome}, founder 2d: ${sent.founder}, 14d check-in: ${sent.checkin}`);
}

run().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
