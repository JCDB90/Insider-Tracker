'use strict';
/**
 * Daily Data Quality Health Check
 *
 * Runs after the daily scraping pipeline. Checks for:
 *   a) Price anomalies (suspiciously low or high)
 *   b) Missing fields on recent transactions
 *   c) Suspicious insider names
 *   d) Duplicate transactions
 *   e) Bilateral transfer pairs
 *   f) Transaction price vs company-peer prices (unusual price proxy)
 *
 * Sends an email to ALERT_EMAIL only when issues are found.
 * Silent if all checks pass.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY     = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const ALERT_EMAIL      = 'jcdeboer@yahoo.com';
const FROM_EMAIL       = 'hello@insidersalpha.com';
const LOOKBACK_DAYS    = parseInt(process.env.HEALTH_LOOKBACK_DAYS || '2');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendAlert(subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('  ⚠  RESEND_API_KEY not set — skipping alert email');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: FROM_EMAIL, to: ALERT_EMAIL, subject, html }),
  });
  if (!res.ok) console.error('  ❌ Resend error:', res.status, await res.text());
}

function tableHtml(headers, rows) {
  if (!rows.length) return '<p style="color:#6B7280;font-size:13px">None</p>';
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px">
      <thead><tr>${headers.map(h=>`<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #f0f0f0;color:#9CA3AF;font-size:11px;text-transform:uppercase">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td style="padding:6px 10px;border-bottom:1px solid #f8f8f8;color:#374151">${c??'—'}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`.trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cutoffDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkPriceAnomalies(since) {
  const { data } = await sb
    .from('insider_transactions')
    .select('company, ticker, country_code, insider_name, price_per_share, transaction_date')
    .gte('transaction_date', since)
    .gt('price_per_share', 0)
    .or('price_per_share.lt.0.01,price_per_share.gt.100000');
  return data || [];
}

async function checkMissingFields(since) {
  const { data } = await sb
    .from('insider_transactions')
    .select('country_code, company, insider_name, shares, price_per_share, total_value, transaction_date')
    .gte('transaction_date', since)
    .or('insider_name.is.null,shares.is.null,shares.eq.0,price_per_share.is.null,price_per_share.eq.0,total_value.is.null,total_value.eq.0');
  if (!data) return {};
  const byCc = {};
  for (const r of data) byCc[r.country_code] = (byCc[r.country_code] || 0) + 1;
  return byCc;
}

async function checkSuspiciousNames(since) {
  const { data } = await sb
    .from('insider_transactions')
    .select('id, insider_name, company, country_code, transaction_date')
    .gte('transaction_date', since)
    .not('insider_name', 'is', null);
  if (!data) return [];
  const BAD_NAME = /^\s*$|^\d{3,}|error|null|undefined/i;
  const SHORT    = n => n && n.trim().length < 4;
  return data.filter(r =>
    BAD_NAME.test(r.insider_name) ||
    SHORT(r.insider_name) ||
    r.insider_name.length > 200     // full-document capture bug
  );
}

async function checkDuplicates(since) {
  const { data } = await sb
    .from('insider_transactions')
    .select('company, insider_name, transaction_date, transaction_type, shares, price_per_share, filing_id')
    .gte('transaction_date', since);
  if (!data) return [];
  const groups = {};
  for (const r of data) {
    const k = [r.company, r.insider_name, r.transaction_date, r.transaction_type, r.shares, r.price_per_share].join('|');
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  }
  return Object.values(groups).filter(g => g.length > 1).map(g => ({
    company: g[0].company, insider: g[0].insider_name,
    date: g[0].transaction_date, type: g[0].transaction_type,
    shares: g[0].shares, count: g.length,
  }));
}

async function checkBilateralTransfers(since) {
  const { data } = await sb
    .from('insider_transactions')
    .select('company, insider_name, transaction_date, transaction_type, shares, price_per_share')
    .gte('transaction_date', since)
    .in('transaction_type', ['BUY', 'SELL']);
  if (!data) return [];
  const groups = {};
  for (const r of data) {
    const k = [r.company, r.insider_name, r.transaction_date, r.shares, r.price_per_share].join('|');
    if (!groups[k]) groups[k] = new Set();
    groups[k].add(r.transaction_type);
  }
  return Object.entries(groups)
    .filter(([, types]) => types.size > 1)
    .map(([k]) => {
      const [company, insider, date] = k.split('|');
      return { company, insider, date };
    });
}

async function checkUnusualPrices(since) {
  // Load all transactions and check peer-price ratio
  const { data: recent } = await sb
    .from('insider_transactions')
    .select('id, company, insider_name, country_code, price_per_share, transaction_date, transaction_type')
    .gte('transaction_date', since)
    .in('transaction_type', ['BUY', 'SELL'])
    .gt('price_per_share', 1);
  if (!recent?.length) return [];

  // Load last 90 days of data for company-peer comparison
  const since90 = cutoffDate(90);
  const { data: peers } = await sb
    .from('insider_transactions')
    .select('company, price_per_share, transaction_date')
    .gte('transaction_date', since90)
    .gt('price_per_share', 1)
    .in('transaction_type', ['BUY', 'SELL']);
  if (!peers) return [];

  // Build per-company price arrays
  const companyPrices = {};
  for (const p of peers) {
    if (!companyPrices[p.company]) companyPrices[p.company] = [];
    companyPrices[p.company].push(p.price_per_share);
  }

  const flagged = [];
  for (const r of recent) {
    const prices = (companyPrices[r.company] || []).filter(p => p !== r.price_per_share).sort((a,b)=>a-b);
    if (prices.length < 2) continue;
    const median = prices[Math.floor(prices.length / 2)];
    if (r.price_per_share < median * 0.75) {
      flagged.push({
        company: r.company, insider: r.insider_name, country: r.country_code,
        date: r.transaction_date, tx_price: r.price_per_share,
        peer_median: Math.round(median * 100) / 100,
        ratio: (r.price_per_share / median).toFixed(2),
      });
    }
  }
  return flagged;
}

// ── Check g): Stale scrapers ──────────────────────────────────────────────────
// A market is "stale" if its newest row (by created_at) is older than STALE_HOURS.
// This catches silent failures where a scraper hung/crashed without logging an error.
const STALE_HOURS = 48; // alert if a market hasn't produced new rows in 2 days
const CORE_MARKETS = ['DE','FR','SE','NO','DK','FI','NL','BE','ES','IT','CH','GB','PT','LU','KR'];

async function checkStaleScrapers() {
  const { data } = await sb
    .from('insider_transactions')
    .select('country_code, created_at')
    .in('country_code', CORE_MARKETS)
    .order('created_at', { ascending: false });
  if (!data) return [];

  // Get most recent created_at per market
  const latest = {};
  for (const r of data) {
    if (!latest[r.country_code]) latest[r.country_code] = r.created_at;
  }

  const stale = [];
  const now = Date.now();
  for (const cc of CORE_MARKETS) {
    const lastRun = latest[cc] ? new Date(latest[cc]).getTime() : 0;
    const hoursAgo = Math.round((now - lastRun) / 3600000);
    if (hoursAgo >= STALE_HOURS) {
      stale.push({ country_code: cc, hours_ago: hoursAgo, last_seen: latest[cc]?.slice(0,16) || 'never' });
    }
  }
  return stale;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🩺  Daily Health Check — checking last', LOOKBACK_DAYS, 'days');
  const since  = cutoffDate(LOOKBACK_DAYS);
  const today  = new Date().toISOString().slice(0, 10);

  const [priceAnomalies, missingFields, suspiciousNames, duplicates, bilateralTransfers, unusualPrices, staleScrapers] =
    await Promise.all([
      checkPriceAnomalies(since),
      checkMissingFields(since),
      checkSuspiciousNames(since),
      checkDuplicates(since),
      checkBilateralTransfers(since),
      checkUnusualPrices(since),
      checkStaleScrapers(),
    ]);

  const missingCount  = Object.values(missingFields).reduce((s, n) => s + n, 0);
  const totalIssues   = priceAnomalies.length + missingCount + suspiciousNames.length +
                        duplicates.length + bilateralTransfers.length + unusualPrices.length +
                        staleScrapers.length;

  // Log summary
  console.log(`  a) Price anomalies:       ${priceAnomalies.length}`);
  console.log(`  b) Missing fields:        ${missingCount} (${Object.entries(missingFields).map(([cc,n])=>`${cc}:${n}`).join(', ')||'none'})`);
  console.log(`  c) Suspicious names:      ${suspiciousNames.length}`);
  console.log(`  d) Duplicates:            ${duplicates.length}`);
  console.log(`  e) Bilateral transfers:   ${bilateralTransfers.length}`);
  console.log(`  f) Unusual prices:        ${unusualPrices.length}`);
  console.log(`  g) Stale scrapers (>${STALE_HOURS}h): ${staleScrapers.length}${staleScrapers.length?(' — '+staleScrapers.map(s=>s.country_code+'('+s.hours_ago+'h)').join(', ')):''}`);
  console.log(`  Total issues:             ${totalIssues}`);

  if (totalIssues === 0) {
    console.log('  ✅ All checks passed — no email sent');
    return;
  }

  // Build email
  const affectedMarkets = [...new Set([
    ...priceAnomalies.map(r=>r.country_code),
    ...Object.keys(missingFields),
    ...suspiciousNames.map(r=>r.country_code),
    ...unusualPrices.map(r=>r.country),
    ...staleScrapers.map(r=>r.country_code),
  ])].join(', ') || 'various';

  const html = `
<!DOCTYPE html><html><body style="font-family:'Inter',Arial,sans-serif;max-width:700px;margin:0 auto;padding:24px;color:#111318">
  <h2 style="font-size:18px;font-weight:700;margin:0 0 4px">⚠️ InsidersAlpha Data Quality Report</h2>
  <p style="color:#6B7280;font-size:13px;margin:0 0 24px">${today} · ${totalIssues} issue${totalIssues!==1?'s':''} found across ${affectedMarkets}</p>

  <h3 style="font-size:14px;font-weight:700;margin:0 0 8px">a) Price Anomalies (${priceAnomalies.length})</h3>
  <p style="font-size:12px;color:#6B7280;margin:0 0 8px">Transactions with price &lt; 0.01 or &gt; 100,000</p>
  ${tableHtml(['Company','Country','Insider','Price','Date'],priceAnomalies.map(r=>[r.company,r.country_code,r.insider_name,r.price_per_share,r.transaction_date]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">b) Missing Fields (${missingCount})</h3>
  <p style="font-size:12px;color:#6B7280;margin:0 0 8px">Transactions missing name, shares, price, or value</p>
  ${tableHtml(['Country','Count'],Object.entries(missingFields).sort((a,b)=>b[1]-a[1]).map(([cc,n])=>[cc,n]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">c) Suspicious Names (${suspiciousNames.length})</h3>
  ${tableHtml(['Company','Country','Name','Date'],suspiciousNames.map(r=>[r.company,r.country_code,(r.insider_name||'').slice(0,40),r.transaction_date]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">d) Duplicates (${duplicates.length})</h3>
  ${tableHtml(['Company','Insider','Date','Type','Shares','Count'],duplicates.map(r=>[r.company,r.insider,r.date,r.type,r.shares,r.count]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">e) Bilateral Transfers (${bilateralTransfers.length})</h3>
  <p style="font-size:12px;color:#6B7280;margin:0 0 8px">Same insider, same day, same shares — BUY + SELL pair (should be filtered by db.js)</p>
  ${tableHtml(['Company','Insider','Date'],bilateralTransfers.map(r=>[r.company,r.insider,r.date]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">f) Unusual Prices — likely option exercises (${unusualPrices.length})</h3>
  <p style="font-size:12px;color:#6B7280;margin:0 0 8px">Transaction price &lt; 75% of company peer median — review manually</p>
  ${tableHtml(['Company','Country','Insider','Tx Price','Peer Median','Ratio','Date'],unusualPrices.map(r=>[r.company,r.country,r.insider,r.tx_price,r.peer_median,r.ratio,r.date]))}

  <h3 style="font-size:14px;font-weight:700;margin:16px 0 8px">g) Stale Scrapers — no new data in ${STALE_HOURS}h+ (${staleScrapers.length})</h3>
  <p style="font-size:12px;color:#6B7280;margin:0 0 8px">Markets whose scraper may have hung or failed silently</p>
  ${tableHtml(['Market','Hours Since Last Row','Last Seen'],staleScrapers.map(r=>[r.country_code,r.hours_ago+'h',r.last_seen]))}

  <hr style="margin:24px 0;border:none;border-top:1px solid #f0f0f0">
  <p style="font-size:11px;color:#9CA3AF">InsidersAlpha automated health check · <a href="https://www.insidersalpha.com" style="color:#9CA3AF">insidersalpha.com</a></p>
</body></html>`.trim();

  await sendAlert(`⚠️ InsidersAlpha Data Quality Report — ${today} (${totalIssues} issues)`, html);
  console.log(`  📧 Alert email sent to ${ALERT_EMAIL}`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
