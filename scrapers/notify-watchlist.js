'use strict';
/**
 * Watchlist Email Notifier
 *
 * Sends one email per user per day summarising insider transactions
 * in their personal watchlist stocks.
 *
 * Run after flag-signals.js in run-daily.sh.
 *
 * Env vars required:
 *   SUPABASE_URL              — already set
 *   SUPABASE_SERVICE_ROLE_KEY — get from Supabase → Settings → API → service_role key
 *                               Needed to bypass RLS and read all user_profiles rows.
 *                               Falls back to SUPABASE_KEY (anon) with degraded access.
 *   RESEND_API_KEY            — get from Vercel env vars, add to /opt/insider-tracker/.env
 *   NOTIFY_OWNER_EMAIL        — (optional) fallback email for global-watchlist mode
 *                               e.g. NOTIFY_OWNER_EMAIL=jcdeboer@yahoo.com
 *
 * Schema dependencies (run migration 002 in Supabase SQL editor):
 *   watchlist.user_id         — links watchlist rows to auth.users
 *   user_profiles.email       — already exists
 *   user_profiles.last_notified_at
 *   user_profiles.notification_opt_in
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';

// Use service_role key when available — it bypasses RLS, letting the scraper
// read all user_profiles rows. The anon/publishable key sees 0 rows because
// RLS restricts reads to `auth.uid() = id` (each user sees only their own row).
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY    = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const sb = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY);

if (!SERVICE_KEY) {
  console.warn('  ⚠  SUPABASE_SERVICE_ROLE_KEY not set — falling back to anon key.');
  console.warn('     RLS will hide user_profiles rows. Add service_role key to .env for full operation.');
}

const FROM_ADDRESS  = 'InsidersAlpha Alerts <alerts@insidersalpha.com>';
const APP_URL       = 'https://www.insidersalpha.com';
const DRY_RUN       = process.argv.includes('--dry-run');
const OWNER_EMAIL   = process.env.NOTIFY_OWNER_EMAIL || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function fmtValue(val, currency = 'EUR') {
  if (!val) return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${currency} ${Math.round(n / 1_000)}K`;
  return `${currency} ${n.toLocaleString()}`;
}

function signalLine(t) {
  const badges = [];
  if (t.is_cluster_buy)    badges.push('🔄 Cluster buy');
  if (t.is_repetitive_buy)   badges.push('🔁 Repeated buy');
  if (t.is_price_dip)  badges.push('📉 Price dip buy');
  if (t.is_pre_earnings)   badges.push('📅 Pre-earnings');
  return badges.length ? badges.join(' · ') : null;
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`  ⚠  RESEND_API_KEY not set — skipping email to ${to}`);
    console.warn('     Add RESEND_API_KEY=re_xxx to /opt/insider-tracker/.env');
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

function buildEmailHtml(userEmail, groups) {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const flagMap = {
    BE:'🇧🇪',CH:'🇨🇭',DE:'🇩🇪',DK:'🇩🇰',ES:'🇪🇸',FI:'🇫🇮',
    FR:'🇫🇷',GB:'🇬🇧',IT:'🇮🇹',KR:'🇰🇷',NL:'🇳🇱',NO:'🇳🇴',SE:'🇸🇪',
  };

  const companyBlocks = groups.map(({ company, ticker, country_code, transactions }) => {
    const flag = flagMap[country_code] || '';
    const txLines = transactions.map(t => {
      const action  = t.transaction_type === 'BUY' ? 'bought' : 'sold';
      const value   = fmtValue(t.total_value, t.currency);
      const price   = t.price_per_share ? ` @ ${t.currency || 'EUR'} ${t.price_per_share}` : '';
      const signals = signalLine(t);
      let line = `<strong>${t.insider_name || 'Insider'}</strong> ${action}`;
      if (value) line += ` <strong>${value}</strong>`;
      if (price) line += price;
      if (signals) line += `<br><span style="color:#9CA3AF;font-size:12px">  ${signals}</span>`;
      return `<li style="margin-bottom:8px">${line}</li>`;
    }).join('\n');

    return `
    <div style="margin-bottom:18px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #0f1117">
      <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#111318">
        ${flag} ${company} <span style="color:#9CA3AF;font-weight:400;font-size:12px">${ticker}</span>
      </div>
      <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.7">${txLines}</ul>
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
      Insider activity on your watchlist
    </h2>
    ${companyBlocks}
    <div style="margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#0f1117;color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-size:13px;font-weight:600">
        View full details →
      </a>
    </div>
  </div>
  <div style="padding:16px 28px;border-top:1px solid #f0f0f0;font-size:11px;color:#9CA3AF">
    InsidersAlpha · Daily watchlist alerts ·
    <a href="${APP_URL}/unsubscribe?email=${encodeURIComponent(userEmail)}" style="color:#9CA3AF">Unsubscribe</a>
  </div>
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function notifyWatchlist() {
  console.log('📬  Watchlist Email Notifier');
  const today = todayIso();
  console.log(`  Date: ${today}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`  Key:  ${SERVICE_KEY ? 'service_role (RLS bypassed ✓)' : 'anon (RLS active — will see 0 user profiles)'}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // PATH A — personal watchlists (requires migration 002 + service_role key)
  // ─────────────────────────────────────────────────────────────────────────────

  // 1. Check if watchlist.user_id column exists
  const { error: colCheck } = await sb.from('watchlist').select('user_id').limit(1);
  const hasUserIdCol = !colCheck?.message?.includes('user_id');

  if (!hasUserIdCol) {
    console.log('  ⚠  watchlist.user_id column missing — run migration 002 in Supabase SQL editor');
    console.log('     File: scrapers/migrations/002_watchlist_user_notifications.sql');
    console.log('     Falling back to global-watchlist mode…\n');
    return notifyGlobal(today);
  }

  // 2. Get users eligible for notification
  // notification_opt_in: true OR null (new users without the column set default to getting alerts)
  const { data: profiles, error: profilesErr } = await sb
    .from('user_profiles')
    .select('id, email, last_notified_at')
    .not('email', 'is', null)
    .or('notification_opt_in.eq.true,notification_opt_in.is.null')
    .or(`last_notified_at.is.null,last_notified_at.lt.${today}`);

  if (profilesErr) {
    console.error('  ❌ user_profiles query:', profilesErr.message);
    return { sent: 0 };
  }

  if (!profiles?.length) {
    console.log('  ℹ  No users eligible for notification today');
    if (!SERVICE_KEY) {
      console.log('     (0 rows visible — anon key cannot read other users\' profiles via RLS)');
      console.log('     Add SUPABASE_SERVICE_ROLE_KEY to .env to fix this');
    }
    return { sent: 0 };
  }

  console.log(`  ${profiles.length} user(s) eligible`);

  // 3. Get personal watchlist tickers per user
  const userIds = profiles.map(p => p.id);
  const { data: wlRows, error: wlErr } = await sb
    .from('watchlist')
    .select('user_id, ticker, company, country_code')
    .in('user_id', userIds);

  if (wlErr) { console.error('  ❌ watchlist query:', wlErr.message); return { sent: 0 }; }

  const userWatchlists = {};
  for (const row of (wlRows || [])) {
    if (!row.user_id) continue;
    (userWatchlists[row.user_id] ??= []).push(row);
  }

  const usersWithStocks = profiles.filter(p => userWatchlists[p.id]?.length > 0);
  if (!usersWithStocks.length) {
    console.log('  ℹ  No personal watchlist entries found (user_id linked rows)');
    console.log('     Stocks added before migration 002 have no user_id — re-add them from the app');
    return { sent: 0 };
  }

  // 4. Today's transactions for all relevant tickers
  const allTickers = [...new Set(wlRows.map(w => w.ticker).filter(Boolean))];
  const { data: todayTrades, error: tradesErr } = await sb
    .from('insider_transactions')
    .select('ticker, country_code, company, insider_name, transaction_type, total_value, price_per_share, currency, is_cluster_buy, is_repetitive_buy, is_price_dip, is_pre_earnings')
    .in('ticker', allTickers)
    .eq('transaction_date', today)
    .in('transaction_type', ['BUY', 'SELL']);

  if (tradesErr) { console.error('  ❌ trades query:', tradesErr.message); return { sent: 0 }; }

  if (!todayTrades?.length) {
    console.log('  ℹ  No watchlist transactions today — no emails sent');
    return { sent: 0 };
  }

  console.log(`  ${todayTrades.length} transaction(s) across ${allTickers.length} tickers`);

  // 5. Send per-user emails
  return sendToUsers(usersWithStocks, userWatchlists, todayTrades, today);
}

// ── Global-watchlist fallback ─────────────────────────────────────────────────
// Used when migration 002 hasn't been run yet.
// Sends to NOTIFY_OWNER_EMAIL if today's trades match any watchlist ticker.

async function notifyGlobal(today) {
  if (!OWNER_EMAIL) {
    console.log('  ℹ  Set NOTIFY_OWNER_EMAIL=your@email.com in .env to receive global-watchlist alerts');
    return { sent: 0 };
  }

  const { data: wlRows } = await sb.from('watchlist').select('ticker, company, country_code');
  if (!wlRows?.length) { console.log('  ℹ  Watchlist is empty'); return { sent: 0 }; }

  const tickers = [...new Set(wlRows.map(w => w.ticker))];
  console.log(`  Global watchlist: ${tickers.length} tickers — checking for today's transactions`);

  const { data: todayTrades, error } = await sb
    .from('insider_transactions')
    .select('ticker, country_code, company, insider_name, transaction_type, total_value, price_per_share, currency, is_cluster_buy, is_repetitive_buy, is_price_dip, is_pre_earnings')
    .in('ticker', tickers)
    .eq('transaction_date', today)
    .in('transaction_type', ['BUY', 'SELL']);

  if (error) { console.error('  ❌ trades query:', error.message); return { sent: 0 }; }

  if (!todayTrades?.length) {
    console.log('  ℹ  No watchlist transactions today — no email sent');
    return { sent: 0 };
  }

  const fakeProfile = { id: 'owner', email: OWNER_EMAIL, last_notified_at: null };
  const fakeWatchlist = { owner: wlRows };
  console.log(`  ${todayTrades.length} transaction(s) found — sending to ${OWNER_EMAIL}`);

  return sendToUsers([fakeProfile], fakeWatchlist, todayTrades, today);
}

// ── Shared send logic ─────────────────────────────────────────────────────────

async function sendToUsers(profiles, userWatchlists, todayTrades, today) {
  let sent = 0;

  for (const profile of profiles) {
    const myStocks = userWatchlists[profile.id] || [];
    const myTrades = todayTrades.filter(t =>
      myStocks.some(s => s.ticker === t.ticker && s.country_code === t.country_code)
    );
    if (!myTrades.length) continue;

    // Group by company
    const byCompany = {};
    for (const t of myTrades) {
      const key = `${t.ticker}|${t.country_code}`;
      if (!byCompany[key]) byCompany[key] = { ticker: t.ticker, company: t.company || t.ticker, country_code: t.country_code, transactions: [] };
      byCompany[key].transactions.push(t);
    }
    const groups = Object.values(byCompany);

    const subject = myTrades.length === 1
      ? `InsidersAlpha: ${groups[0].company} insider ${myTrades[0].transaction_type === 'BUY' ? 'bought' : 'sold'} today`
      : `InsidersAlpha: Insider activity on ${groups.length} watchlist stock${groups.length > 1 ? 's' : ''} today`;
    const html = buildEmailHtml(profile.email, groups);

    console.log(`  → ${profile.email}: ${myTrades.length} trade(s) in ${groups.map(g => g.ticker).join(', ')}`);
    groups.forEach(g => g.transactions.forEach(t =>
      console.log(`    ${g.company}: ${t.insider_name||'?'} ${t.transaction_type} ${fmtValue(t.total_value, t.currency) || ''}`)
    ));

    if (DRY_RUN) {
      console.log(`    [DRY RUN] Subject: "${subject}"`);
      sent++;
      continue;
    }

    const ok = await sendEmail(profile.email, subject, html);
    if (ok) {
      // Only update last_notified_at for real user profiles (not the fake owner profile)
      if (profile.id !== 'owner') {
        await sb.from('user_profiles').update({ last_notified_at: today }).eq('id', profile.id);
      }
      sent++;
      console.log(`    ✅ Sent`);
    }
  }

  console.log(`\n  Summary: ${sent} email(s) sent`);
  return { sent };
}

notifyWatchlist().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
