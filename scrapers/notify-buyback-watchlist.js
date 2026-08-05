'use strict';
// Load .env from repo root — works whether run manually or via run-daily.sh
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * Buyback Watchlist Email Notifier
 *
 * Sends one email per user per run announcing NEW buyback_programs rows
 * (company + country_code match) for stocks on their personal watchlist.
 *
 * Same high-water-mark pattern as notify-watchlist.js — filters on `created_at`
 * against this script's own last successful run (read back from scraper_runs),
 * not on announced_date, so a program disclosed today but only scraped/saved a
 * few days later still gets caught exactly once.
 *
 * Deliberately does NOT touch user_profiles.last_notified_at — that column is
 * notify-watchlist.js's own daily-send gate for insider-transaction alerts.
 * Writing to it here would make the two notifiers race: whichever runs first
 * in a given day would silently suppress the other's alerts for hours. The
 * created_at high-water mark alone is sufficient to prevent duplicate buyback
 * emails, since buyback programs are announced far less often than trades.
 *
 * Run after the buyback scrapers (Saturday 07:00 UTC pipeline), or daily at
 * 18:00 UTC per the brief — see scrapers/notify-buyback-watchlist.js's
 * crontab line reported at the end of the build session.
 *
 * Env vars required: same as notify-watchlist.js (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, optional NOTIFY_OWNER_EMAIL).
 *
 * Schema dependencies: watchlist.user_id (migration 002), user_profiles.email,
 * user_profiles.notification_opt_in.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY    = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const sb = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY);

if (!SERVICE_KEY) {
  console.warn('  ⚠  SUPABASE_SERVICE_ROLE_KEY not set — falling back to anon key.');
  console.warn('     RLS will hide user_profiles rows. Add service_role key to .env for full operation.');
}

const FROM_ADDRESS = 'InsidersAlpha Alerts <alerts@insidersalpha.com>';
const APP_URL       = 'https://www.insidersalpha.com';
const DRY_RUN       = process.argv.includes('--dry-run');
const OWNER_EMAIL   = process.env.NOTIFY_OWNER_EMAIL || null;
const RUN_LABEL     = 'buyback-notify'; // pseudo country_code for scraper_runs history
const FALLBACK_LOOKBACK_HOURS = 7 * 24; // buybacks are scraped weekly — bound first-run catch-up to that window
const ACTIVE_STATUSES = ['Active', 'Announced', 'active', 'announced'];

const FLAG_MAP = {
  BE:'🇧🇪',CH:'🇨🇭',DE:'🇩🇪',DK:'🇩🇰',ES:'🇪🇸',FI:'🇫🇮',
  FR:'🇫🇷',GB:'🇬🇧',IT:'🇮🇹',KR:'🇰🇷',NL:'🇳🇱',NO:'🇳🇴',SE:'🇸🇪',
  AT:'🇦🇹',LU:'🇱🇺',PL:'🇵🇱',PT:'🇵🇹',SG:'🇸🇬',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCreatedAtCutoff() {
  const { data, error } = await sb
    .from('scraper_runs')
    .select('ran_at')
    .eq('country_code', RUN_LABEL)
    .eq('status', 'success')
    .order('ran_at', { ascending: false })
    .limit(1);
  if (!error && data?.length) return data[0].ran_at;
  return new Date(Date.now() - FALLBACK_LOOKBACK_HOURS * 3600 * 1000).toISOString();
}

async function logRun(rowsSaved, durationS, status = 'success') {
  if (DRY_RUN) return; // a --dry-run must never advance the real high-water mark
  try {
    await sb.from('scraper_runs').insert({ country_code: RUN_LABEL, rows_saved: rowsSaved ?? 0, duration_s: durationS, status });
  } catch { /* non-fatal — a missing/unreachable scraper_runs table shouldn't crash the notifier */ }
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`  ⚠  RESEND_API_KEY not set — skipping email to ${to}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`  ❌ Resend ${res.status}:`, err?.message || JSON.stringify(err));
    return false;
  }
  return true;
}

// ── Email template ────────────────────────────────────────────────────────────

function buildEmailHtml(userEmail, programs) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const blocks = programs.map(p => {
    const flag = FLAG_MAP[p.country_code] || '';
    const announced = formatDate(p.announced_date);
    const expires = p.program_end ? formatDate(p.program_end) : 'Not specified';
    return `
    <div style="margin-bottom:18px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #0f1117">
      <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#111318">
        ${flag} ${p.company} <span style="color:#9CA3AF;font-weight:400;font-size:12px">${p.ticker || ''}</span>
      </div>
      <p style="margin:0 0 10px;color:#374151;font-size:13px;line-height:1.6">
        ${p.company} has announced a new share buyback program.
      </p>
      <ul style="margin:0 0 10px;padding-left:18px;color:#374151;font-size:13px;line-height:1.7">
        <li>Announced: <strong>${announced}</strong></li>
        <li>Expires: <strong>${expires}</strong></li>
        <li>Source: <strong>${p.source || 'Regulatory filing'}</strong></li>
      </ul>
      ${p.filing_url ? `<a href="${p.filing_url}" style="font-size:12px;color:#0f1117;font-weight:600;text-decoration:none">View official filing →</a>` : ''}
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="background:#0f1117;padding:20px 28px">
    <span style="color:#fff;font-size:17px;font-weight:700;letter-spacing:-0.02em">InsidersAlpha</span>
  </div>
  <div style="padding:28px">
    <p style="color:#6B7280;font-size:13px;margin:0 0 6px">${today}</p>
    <h2 style="font-size:20px;font-weight:700;color:#111318;margin:0 0 22px;letter-spacing:-0.02em">
      New buyback program${programs.length > 1 ? 's' : ''} on your watchlist
    </h2>
    ${blocks}
    <div style="margin-top:8px;padding:14px 16px;background:#eef2ff;border-radius:8px">
      <p style="margin:0;color:#374151;font-size:12px;line-height:1.6">
        <strong>Why this matters:</strong> an active buyback program means the company is
        buying its own shares, supporting the stock price. Combined with insider purchases,
        this signals strong management conviction in the company's value.
      </p>
    </div>
    <div style="margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#0f1117;color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-size:13px;font-weight:600">
        Manage watchlist →
      </a>
    </div>
  </div>
  <div style="padding:16px 28px;border-top:1px solid #f0f0f0;font-size:11px;color:#9CA3AF">
    InsidersAlpha · Buyback watchlist alerts ·
    <a href="${APP_URL}/unsubscribe?email=${encodeURIComponent(userEmail)}" style="color:#9CA3AF">Unsubscribe</a>
  </div>
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function notifyBuybackWatchlist() {
  console.log('📬  Buyback Watchlist Email Notifier');
  const cutoff = await getCreatedAtCutoff();
  console.log(`  ${DRY_RUN ? '[DRY RUN] ' : ''}New-program cutoff: ${cutoff} (created_at >= this)`);
  console.log(`  Key:  ${SERVICE_KEY ? 'service_role (RLS bypassed ✓)' : 'anon (RLS active — will see 0 user profiles)'}`);

  // 1. New buyback programs since last successful run
  const { data: newPrograms, error: programsErr } = await sb
    .from('buyback_programs')
    .select('company, ticker, country_code, announced_date, program_end, filing_url, source, status, created_at')
    .gte('created_at', cutoff)
    .in('status', ACTIVE_STATUSES);

  if (programsErr) { console.error('  ❌ buyback_programs query:', programsErr.message); return { sent: 0, ok: false }; }

  if (!newPrograms?.length) {
    console.log('  ℹ  No new buyback programs since last check — no emails sent');
    return { sent: 0 };
  }
  console.log(`  ${newPrograms.length} new buyback program row(s) found`);

  // ─────────────────────────────────────────────────────────────────────────────
  // PATH A — personal watchlists (requires migration 002 + service_role key)
  // ─────────────────────────────────────────────────────────────────────────────

  const { error: colCheck } = await sb.from('watchlist').select('user_id').limit(1);
  const hasUserIdCol = !colCheck?.message?.includes('user_id');

  if (!hasUserIdCol) {
    console.log('  ⚠  watchlist.user_id column missing — run migration 002 in Supabase SQL editor');
    console.log('     Falling back to global-watchlist mode…\n');
    return notifyGlobal(newPrograms);
  }

  const { data: profiles, error: profilesErr } = await sb
    .from('user_profiles')
    .select('id, email')
    .not('email', 'is', null)
    .or('notification_opt_in.eq.true,notification_opt_in.is.null');

  if (profilesErr) { console.error('  ❌ user_profiles query:', profilesErr.message); return { sent: 0, ok: false }; }

  if (!profiles?.length) {
    console.log('  ℹ  No users eligible for notification');
    if (!SERVICE_KEY) console.log('     (0 rows visible — anon key cannot read other users\' profiles via RLS)');
    return { sent: 0 };
  }

  const userIds = profiles.map(p => p.id);
  const { data: wlRows, error: wlErr } = await sb
    .from('watchlist')
    .select('user_id, ticker, company, country_code')
    .in('user_id', userIds);

  if (wlErr) { console.error('  ❌ watchlist query:', wlErr.message); return { sent: 0, ok: false }; }

  const userWatchlists = {};
  for (const row of (wlRows || [])) {
    if (!row.user_id) continue;
    (userWatchlists[row.user_id] ??= []).push(row);
  }

  const usersWithStocks = profiles.filter(p => userWatchlists[p.id]?.length > 0);
  if (!usersWithStocks.length) {
    console.log('  ℹ  No personal watchlist entries found (user_id linked rows)');
    return { sent: 0 };
  }

  return sendToUsers(usersWithStocks, userWatchlists, newPrograms);
}

// ── Global-watchlist fallback ─────────────────────────────────────────────────

async function notifyGlobal(newPrograms) {
  if (!OWNER_EMAIL) {
    console.log('  ℹ  Set NOTIFY_OWNER_EMAIL=your@email.com in .env to receive global-watchlist alerts');
    return { sent: 0 };
  }

  const { data: wlRows } = await sb.from('watchlist').select('ticker, company, country_code');
  if (!wlRows?.length) { console.log('  ℹ  Watchlist is empty'); return { sent: 0 }; }

  const fakeProfile = { id: 'owner', email: OWNER_EMAIL };
  const fakeWatchlist = { owner: wlRows };
  return sendToUsers([fakeProfile], fakeWatchlist, newPrograms);
}

// ── Shared send logic ─────────────────────────────────────────────────────────

async function sendToUsers(profiles, userWatchlists, newPrograms) {
  let sent = 0;

  for (const profile of profiles) {
    const myStocks = userWatchlists[profile.id] || [];
    const myPrograms = newPrograms.filter(p =>
      myStocks.some(s => s.ticker === p.ticker && s.country_code === p.country_code)
    );
    if (!myPrograms.length) continue;

    const subject = myPrograms.length === 1
      ? `🔄 New buyback: ${myPrograms[0].company} (${myPrograms[0].ticker})`
      : `🔄 New buybacks on ${myPrograms.length} watchlist stocks`;
    const html = buildEmailHtml(profile.email, myPrograms);

    console.log(`  → ${profile.email}: ${myPrograms.length} new program(s) in ${myPrograms.map(p => p.ticker).join(', ')}`);

    if (DRY_RUN) {
      console.log(`    [DRY RUN] Subject: "${subject}"`);
      sent++;
      continue;
    }

    const ok = await sendEmail(profile.email, subject, html);
    if (ok) { sent++; console.log('    ✅ Sent'); }
  }

  console.log(`\n  Summary: ${sent} email(s) sent`);
  return { sent };
}

const t0 = Date.now();
notifyBuybackWatchlist()
  .then(result => logRun(result?.sent ?? 0, (Date.now() - t0) / 1000, result?.ok === false ? 'failed' : 'success'))
  .catch(err => {
    console.error('❌ Fatal:', err.message);
    return logRun(0, (Date.now() - t0) / 1000, 'failed').finally(() => process.exit(1));
  });
