'use strict';
/**
 * Watchlist Email Notifier
 *
 * Sends one email per user per day summarising insider transactions
 * in their personal watchlist stocks.
 *
 * Run after flag-signals.js in run-daily.sh.
 *
 * Requires:
 *   RESEND_API_KEY   — in /opt/insider-tracker/.env
 *   SUPABASE_URL     — already set
 *   SUPABASE_KEY     — already set (service_role bypasses RLS for cross-user reads)
 *
 * Dependency: none beyond @supabase/supabase-js (already installed)
 */

const { supabase } = require('./lib/db');

const FROM_ADDRESS = 'InsidersAlpha Alerts <alerts@insidersalpha.com>';
const APP_URL      = 'https://www.insidersalpha.com';
const DRY_RUN      = process.argv.includes('--dry-run');

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
  if (t.is_repeated_buy)   badges.push('🔁 Repeated buy');
  if (t.is_price_dip_buy)  badges.push('📉 Price dip buy');
  if (t.is_pre_earnings)   badges.push('📅 Pre-earnings');
  return badges.length ? `    ${badges.join(' · ')}` : null;
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠  RESEND_API_KEY not set — cannot send email to', to);
    return false;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('  ❌ Resend error:', res.status, err?.message || JSON.stringify(err));
    return false;
  }
  return true;
}

// ── Email template ────────────────────────────────────────────────────────────

function buildEmailHtml(userEmail, groups) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const companyBlocks = groups.map(({ company, ticker, country_code, transactions }) => {
    const flagMap = {
      BE:'🇧🇪',CH:'🇨🇭',DE:'🇩🇪',DK:'🇩🇰',ES:'🇪🇸',FI:'🇫🇮',
      FR:'🇫🇷',GB:'🇬🇧',IT:'🇮🇹',KR:'🇰🇷',NL:'🇳🇱',NO:'🇳🇴',SE:'🇸🇪',
    };
    const flag = flagMap[country_code] || '';

    const txLines = transactions.map(t => {
      const action  = t.transaction_type === 'BUY' ? 'bought' : 'sold';
      const value   = fmtValue(t.total_value, t.currency);
      const price   = t.price_per_share ? ` @ ${t.currency || 'EUR'} ${t.price_per_share}` : '';
      const signals = signalLine(t);
      let line = `• <strong>${t.insider_name || 'Insider'}</strong> ${action}`;
      if (value) line += ` <strong>${value}</strong>`;
      if (price) line += price;
      if (signals) line += `<br><span style="color:#9CA3AF;font-size:12px">${signals.trim()}</span>`;
      return `<li style="margin-bottom:6px">${line}</li>`;
    }).join('\n');

    return `
      <div style="margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #0f1117">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px">${flag} ${company} <span style="color:#9CA3AF;font-weight:400;font-size:12px">${ticker}</span></div>
        <ul style="margin:0;padding-left:16px;color:#374151;font-size:13px;line-height:1.7">${txLines}</ul>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- Header -->
    <div style="background:#0f1117;padding:24px 28px;display:flex;align-items:center;gap:10px">
      <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.02em">InsidersAlpha</span>
    </div>

    <!-- Body -->
    <div style="padding:28px">
      <p style="color:#374151;font-size:14px;margin:0 0 6px">
        <strong style="color:#111318">${today}</strong>
      </p>
      <h2 style="font-size:20px;font-weight:700;color:#111318;margin:0 0 20px;letter-spacing:-0.02em">
        Insider activity on your watchlist
      </h2>

      ${companyBlocks}

      <div style="margin-top:24px">
        <a href="${APP_URL}" style="display:inline-block;background:#0f1117;color:#fff;text-decoration:none;padding:10px 22px;border-radius:7px;font-size:13px;font-weight:600">
          View full details →
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;border-top:1px solid #f0f0f0;font-size:11px;color:#9CA3AF">
      InsidersAlpha · You're receiving this because you have watchlist alerts enabled.<br>
      <a href="${APP_URL}/account" style="color:#9CA3AF">Manage alerts</a> ·
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

  // ── 1. Get users eligible for notification (not yet notified today) ─────────
  const { data: profiles, error: profilesErr } = await supabase
    .from('user_profiles')
    .select('id, email, last_notified_at')
    .not('email', 'is', null)
    .eq('notification_opt_in', true)
    .or(`last_notified_at.is.null,last_notified_at.lt.${today}`);

  if (profilesErr) {
    // Table may not yet have the notification columns — schema migration pending
    if (profilesErr.message.includes('column') || profilesErr.message.includes('does not exist')) {
      console.log('  ℹ  user_profiles schema not yet migrated — run migration 002');
      console.log('  ℹ  Migration file: scrapers/migrations/002_watchlist_user_notifications.sql');
      return { sent: 0 };
    }
    console.error('  ❌ user_profiles query:', profilesErr.message);
    return { sent: 0 };
  }

  if (!profiles?.length) {
    console.log('  ℹ  No users eligible for notification today (all notified or no accounts)');
    return { sent: 0 };
  }

  console.log(`  ${profiles.length} user(s) eligible for notification`);

  // ── 2. Get each user's watchlist tickers ────────────────────────────────────
  const userIds = profiles.map(p => p.id);
  const { data: watchlistRows, error: watchlistErr } = await supabase
    .from('watchlist')
    .select('user_id, ticker, company, country_code')
    .in('user_id', userIds);

  if (watchlistErr) {
    if (watchlistErr.message.includes('user_id')) {
      console.log('  ℹ  watchlist.user_id column not yet migrated — run migration 002');
      return { sent: 0 };
    }
    console.error('  ❌ watchlist query:', watchlistErr.message);
    return { sent: 0 };
  }

  // Build map: user_id → [{ ticker, company, country_code }]
  const userWatchlists = {};
  for (const row of (watchlistRows || [])) {
    if (!row.user_id) continue;
    (userWatchlists[row.user_id] ??= []).push(row);
  }

  const usersWithWatchlist = profiles.filter(p => userWatchlists[p.id]?.length > 0);
  if (!usersWithWatchlist.length) {
    console.log('  ℹ  No users have personalised watchlist entries yet');
    return { sent: 0 };
  }

  // ── 3. Get today's transactions for all relevant tickers ────────────────────
  const allTickers = [...new Set((watchlistRows || []).map(w => w.ticker).filter(Boolean))];
  if (!allTickers.length) { console.log('  ℹ  No watchlist tickers'); return { sent: 0 }; }

  const { data: todayTrades, error: tradesErr } = await supabase
    .from('insider_transactions')
    .select('ticker, country_code, company, insider_name, transaction_type, total_value, price_per_share, currency, is_cluster_buy, is_repeated_buy, is_price_dip_buy, is_pre_earnings')
    .in('ticker', allTickers)
    .eq('transaction_date', today)
    .in('transaction_type', ['BUY', 'SELL']);

  if (tradesErr) { console.error('  ❌ trades query:', tradesErr.message); return { sent: 0 }; }

  if (!todayTrades?.length) {
    console.log('  ℹ  No watchlist transactions today — no emails to send');
    return { sent: 0 };
  }

  console.log(`  ${todayTrades.length} transaction(s) found today across watchlist tickers`);

  // ── 4. Match trades to users, build per-user email ─────────────────────────
  let sent = 0;

  for (const profile of usersWithWatchlist) {
    const myStocks = userWatchlists[profile.id] || [];
    const myTrades = todayTrades.filter(t =>
      myStocks.some(s => s.ticker === t.ticker && s.country_code === t.country_code)
    );

    if (!myTrades.length) continue;

    // Group by company
    const byCompany = {};
    for (const t of myTrades) {
      const key = `${t.ticker}|${t.country_code}`;
      if (!byCompany[key]) {
        byCompany[key] = {
          ticker:       t.ticker,
          company:      t.company || t.ticker,
          country_code: t.country_code,
          transactions: [],
        };
      }
      byCompany[key].transactions.push(t);
    }

    const groups    = Object.values(byCompany);
    const subject   = `InsidersAlpha: ${myTrades.length === 1
      ? `${groups[0].company} insider ${myTrades[0].transaction_type === 'BUY' ? 'bought' : 'sold'} today`
      : `Insider activity on ${groups.length} watchlist stock${groups.length > 1 ? 's' : ''} today`}`;
    const html      = buildEmailHtml(profile.email, groups);

    console.log(`  → ${profile.email}: ${myTrades.length} trade(s) across ${groups.length} stock(s)`);
    groups.forEach(g => console.log(`    ${g.company} (${g.ticker}): ${g.transactions.length} tx`));

    if (!DRY_RUN) {
      const ok = await sendEmail(profile.email, subject, html);
      if (ok) {
        // Mark as notified today
        await supabase
          .from('user_profiles')
          .update({ last_notified_at: today })
          .eq('id', profile.id);
        sent++;
        console.log(`    ✅ Sent`);
      }
    } else {
      console.log(`    [DRY RUN] Would send: "${subject}"`);
      sent++;
    }
  }

  const elapsed = process.hrtime ? '' : '';
  console.log(`\n  Summary: ${sent} email(s) sent`);
  return { sent };
}

notifyWatchlist().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
