'use strict';
/**
 * Weekly "Seeking Alpha European Insider Conviction" Candidate Monitor
 *
 * Looks back 7 days for a cluster of 2+ insiders buying the same US-listed
 * European company on the open market, above a combined €100K threshold —
 * the shape of story that series covers. Does NOT post anything; emails a
 * candidate writeup for manual review, or a quiet "nothing this week" email.
 *
 * Cron (Hetzner, Monday 08:00 UTC):
 *   0 8 * * 1 cd /opt/insider-tracker && node scrapers/social/seeking-alpha-monitor.js >> logs/seeking-alpha-$(date +\%Y-\%m-\%d).txt 2>&1
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');
const { toEUR } = require('../lib/currency');

const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL       = 'jcdeboer@yahoo.com';
const FROM_EMAIL     = 'hello@insidersalpha.com';
const MIN_INSIDERS   = 2;
const MIN_CLUSTER_EUR = 100000;
const LOOKBACK_DAYS  = 7;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── US-listed European tickers ───────────────────────────────────────────────
//
// Keyed by the HOME-MARKET ticker+country_code exactly as stored in
// insider_transactions (e.g. "MC|FR" for LVMH) — NOT by the US ADR/NYSE
// symbol. Our scrapers pull from the home regulator (AMF, BaFin, AFM, etc.)
// and always store the home-exchange ticker; the US symbol never appears in
// the `ticker` column, so matching on it directly (as an initial draft of
// this list did) would silently match zero rows for every ADR-only entry.
// The `us`/`exchange` fields are cosmetic — used only to label the US
// listing in the output/email, not for matching.
//
// Switzerland is deliberately excluded even though Novartis/Roche/ABB/SGS/
// Zurich Insurance/Nestlé all have real US listings: SER-AG (the Swiss
// regulator our switzerland.js scraper reads) does not disclose individual
// insider names at all — every CH row is stored with insider_name "Not
// disclosed" — and flag-signals.js already explicitly clears is_cluster_buy
// for every CH row for exactly that reason (see its "CH signal flags
// cleared (anonymous insiders)" log line). A 2-distinct-name cluster can
// structurally never occur for a CH ticker, so including one here would be
// dead weight, not a missed opportunity.
//
// Also excluded vs. the original brief: Mizuho (Japanese, not European),
// Costco and BHP (not European at all — likely copy/paste noise), BRD
// Groupe (Romania — outside our 18 covered markets). This is a "European
// Insider Conviction" series; non-European names don't belong regardless of
// ticker-matching correctness.
const US_LISTED = new Map([
  // ── Confirmed against live data (this exact ticker+country has real rows) ──
  ['ASML|NL',  { us: 'ASML',  exchange: 'Nasdaq (direct)' }],
  ['SAP|DE',   { us: 'SAP',   exchange: 'NYSE (direct)' }],
  ['AZN|GB',   { us: 'AZN',   exchange: 'Nasdaq (direct)' }],
  ['TTE|FR',   { us: 'TTE',   exchange: 'NYSE (direct)' }],
  ['EQNR|NO',  { us: 'EQNR',  exchange: 'NYSE (direct)' }],
  ['RIO|GB',   { us: 'RIO',   exchange: 'NYSE (direct)' }],
  ['GSK|GB',   { us: 'GSK',   exchange: 'NYSE (direct)' }],
  ['BP|GB',    { us: 'BP',    exchange: 'NYSE (direct)' }],
  ['ULVR|GB',  { us: 'UL',    exchange: 'NYSE (ADR)' }],
  ['UL|GB',    { us: 'UL',    exchange: 'NYSE (ADR)' }],
  ['PHIA|NL',  { us: 'PHG',   exchange: 'NYSE (ADR)' }],
  ['INGA|NL',  { us: 'ING',   exchange: 'NYSE (ADR)' }],
  ['STMPA|NL', { us: 'STM',   exchange: 'NYSE (direct)' }],
  ['RACE|NL',  { us: 'RACE',  exchange: 'NYSE (direct)' }],
  ['WPP|GB',   { us: 'WPP',   exchange: 'Nasdaq (ADR)' }],
  ['RKT|GB',   { us: 'RKT',   exchange: 'OTC (ADR)' }],
  ['MC|FR',    { us: 'LVMUY', exchange: 'OTC (ADR)' }],
  ['SIE|DE',   { us: 'SIEGY', exchange: 'OTC (ADR)' }],
  ['BNP|FR',   { us: 'BNPQY', exchange: 'OTC (ADR)' }],
  ['RHM|DE',   { us: 'RNMBY', exchange: 'OTC (ADR)' }],
  ['BAYN|DE',  { us: 'BAYRY', exchange: 'OTC (ADR)' }],
  ['BAS|DE',   { us: 'BASFY', exchange: 'OTC (ADR)' }],
  ['DHL|DE',   { us: 'DPSGY', exchange: 'OTC (ADR)' }],
  ['DTE|DE',   { us: 'DTEGY', exchange: 'OTC (ADR)' }],
  ['ATCO-A|SE',{ us: 'ATLCY', exchange: 'OTC (ADR)' }],
  ['VOLV-B|SE',{ us: 'VOLVY', exchange: 'OTC (ADR)' }],
  ['DNB|NO',   { us: 'DNBBY', exchange: 'OTC (ADR)' }],
  ['UPM|FI',   { us: 'UPMKY', exchange: 'OTC (ADR)' }],
  ['NESTE|FI', { us: 'NESTE', exchange: 'OTC (ADR)' }],
  ['ITRK|GB',  { us: 'ITRK',  exchange: 'OTC (ADR)' }],
  ['A5G|GB',   { us: 'AIBGY', exchange: 'OTC (ADR)' }],

  // ── No current rows (zero insider transactions ever scraped for these) —
  // kept for forward coverage the day they start appearing; harmless since
  // there's nothing yet for them to falsely match. ──
  ['SHELL|NL', { us: 'SHEL',  exchange: 'NYSE (direct)' }],
  ['REN|NL',   { us: 'RELX',  exchange: 'NYSE (direct)' }],
  ['AIR|FR',   { us: 'EADSY', exchange: 'OTC (ADR)' }],
  ['VOW3|DE',  { us: 'VWAGY', exchange: 'OTC (ADR)' }],
  ['MOWI|NO',  { us: 'MOWI',  exchange: 'OTC (ADR)' }],
  ['EXPN|GB',  { us: 'EXPGY', exchange: 'OTC (ADR)' }],

  // L'Oréal and L'Air Liquide — previously excluded because every row had
  // ticker = "" (a transient Yahoo-lookup failure at scrape time baked
  // permanently into the DB, since nothing retries an already-saved row).
  // Fixed: isinToTicker.js now hardcodes both ISINs, and the 6 existing
  // affected rows were backfilled to their real tickers (OR, AI).
  ['OR|FR',    { us: 'LRLCY', exchange: 'OTC (ADR)' }],
  ['AI|FR',    { us: 'AIQUY', exchange: 'OTC (ADR)' }],
]);

function isUsListed(ticker, countryCode) {
  return US_LISTED.get(`${ticker}|${countryCode}`) || null;
}

function eurValue(row) {
  return toEUR(Math.abs(Number(row.total_value || 0)), row.currency || 'EUR');
}

const CURRENCY_SYMBOLS = {
  EUR: '€', GBP: '£', SEK: 'SEK ', NOK: 'NOK ', DKK: 'DKK ',
  PLN: 'PLN ', KRW: '₩', CHF: 'CHF ', USD: '$',
};

function formatValue(value, currency) {
  const sym = CURRENCY_SYMBOLS[currency] || '€';
  const v = Math.abs(Number(value || 0));
  if (v >= 1000000) return sym + (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return sym + Math.round(v / 1000) + 'K';
  return sym + Math.round(v);
}

function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

// ── DB query ──────────────────────────────────────────────────────────────────
//
// Supabase's query builder has no GROUP BY/aggregate support, so — matching
// the rest of this codebase's convention (flag-signals.js, generate-tweet.js
// pickCluster()) — fetch the qualifying rows and group them in JS rather
// than writing this as a raw SQL/RPC aggregate query.
async function fetchCandidateRows() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const tickers = [...new Set([...US_LISTED.keys()].map(k => k.split('|')[0]))];

  const { data, error } = await sb
    .from('insider_transactions')
    .select('company,ticker,country_code,insider_name,insider_role,total_value,currency,transaction_date')
    .eq('transaction_type', 'BUY')
    .eq('is_unusual_price', false)   // excludes option exercises / RSU grants / deep-discount plans
    .gt('price_per_share', 0)
    .eq('is_cluster_buy', true)
    .not('insider_name', 'is', null)
    .gte('transaction_date', since)
    .in('ticker', tickers);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  // .in('ticker', ...) can't also constrain country_code (a ticker like
  // "UL" could theoretically collide across markets), so re-check the exact
  // ticker+country_code pair against US_LISTED here.
  return (data || []).filter(r => isUsListed(r.ticker, r.country_code));
}

function groupCandidates(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!groups.has(key)) {
      groups.set(key, {
        company: r.company, ticker: r.ticker, country_code: r.country_code,
        listing: isUsListed(r.ticker, r.country_code),
        insiders: new Map(), // insider_name -> best single row (largest value)
      });
    }
    const g = groups.get(key);
    const existing = g.insiders.get(r.insider_name);
    if (!existing || eurValue(r) > eurValue(existing)) g.insiders.set(r.insider_name, r);
  }

  const candidates = [];
  for (const g of groups.values()) {
    const insiderRows = [...g.insiders.values()];
    if (insiderRows.length < MIN_INSIDERS) continue;
    const totalEur = insiderRows.reduce((s, r) => s + eurValue(r), 0);
    if (totalEur <= MIN_CLUSTER_EUR) continue;
    const dates = insiderRows.map(r => r.transaction_date).sort();
    candidates.push({
      company: g.company, ticker: g.ticker, country_code: g.country_code,
      listing: g.listing, totalEur,
      firstBuy: dates[0], lastBuy: dates[dates.length - 1],
      insiderRows: insiderRows.sort((a, b) => eurValue(b) - eurValue(a)),
    });
  }
  return candidates.sort((a, b) => b.totalEur - a.totalEur);
}

// ── Output ────────────────────────────────────────────────────────────────────

function dateRangeLabel(firstBuy, lastBuy) {
  const a = new Date(firstBuy + 'T12:00:00Z');
  const b = new Date(lastBuy + 'T12:00:00Z');
  const month = b.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return firstBuy === lastBuy
    ? `${month} ${a.getUTCDate()}`
    : `${month} ${a.getUTCDate()}-${b.getUTCDate()}`;
}

function buildReport(candidates, weekOf) {
  const lines = [];
  lines.push('=== Seeking Alpha "European Insider Conviction" Monitor ===');
  lines.push(`Week of: ${weekOf}`);
  lines.push('');

  if (!candidates.length) {
    lines.push('No candidates this week.');
    lines.push('→ Monitor again next week.');
    return lines.join('\n');
  }

  lines.push('CANDIDATES THIS WEEK:');
  for (const c of candidates) {
    lines.push(`✅ ${c.company} ($${c.listing.us}, ${c.listing.exchange})`);
    lines.push(`   ${c.insiderRows.length} insiders bought ${formatValue(c.totalEur, 'EUR')} (${dateRangeLabel(c.firstBuy, c.lastBuy)})`);
    for (const r of c.insiderRows) {
      lines.push(`   • ${r.insider_name} (${r.insider_role || 'Insider'}): ${formatValue(r.total_value, r.currency || 'EUR')}`);
    }
    lines.push('   → ARTICLE CANDIDATE');
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ── Email ─────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendResendEmail(subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('  ⚠  RESEND_API_KEY not set — skipping email');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: TO_EMAIL, subject, html }),
  });
  if (!res.ok) console.error('  ❌ Resend error:', res.status, await res.text());
  else console.log(`  📧 Emailed to ${TO_EMAIL}`);
}

function buildEmailHtml(reportText, candidates) {
  return `
<!DOCTYPE html><html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111318">
  <h2 style="font-size:17px;font-weight:700;margin:0 0 4px">🎯 Seeking Alpha Candidate Monitor</h2>
  <p style="color:#6B7280;font-size:13px;margin:0 0 20px">${candidates.length} candidate${candidates.length === 1 ? '' : 's'} this week</p>
  <pre style="white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:14px;line-height:1.6;background:#f8f8f8;border:1px solid #f0f0f0;border-radius:8px;padding:16px;color:#111318">${escapeHtml(reportText)}</pre>
  <p style="font-size:11px;color:#9CA3AF;margin-top:20px">Auto-generated · InsidersAlpha</p>
</body></html>`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n── Seeking Alpha Candidate Monitor ────────────────────`);
  console.log(`  Week of: ${today} (looking back ${LOOKBACK_DAYS} days)`);

  const rows = await fetchCandidateRows();
  console.log(`  Rows fetched (US-listed, cluster-flagged, open-market BUYs, last ${LOOKBACK_DAYS}d): ${rows.length}`);

  const candidates = groupCandidates(rows);
  console.log(`  Candidates (>=${MIN_INSIDERS} insiders, >€${MIN_CLUSTER_EUR.toLocaleString('en')}): ${candidates.length}`);

  const report = buildReport(candidates, today);
  console.log('\n' + report + '\n');

  if (!candidates.length) {
    await sendResendEmail('🎯 Seeking Alpha monitor: no candidates this week', buildEmailHtml(report, candidates));
    return;
  }

  const top = candidates[0];
  const subject = `🎯 Seeking Alpha candidate: ${top.company} (${top.ticker})`;
  await sendResendEmail(subject, buildEmailHtml(report, candidates));
}

if (require.main === module) {
  main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
}

module.exports = {
  US_LISTED, isUsListed, eurValue, groupCandidates, buildReport,
  formatValue, dateRangeLabel, shortDate,
};
