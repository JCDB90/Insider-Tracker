'use strict';
/**
 * Daily Tweet Draft Generator
 *
 * Picks the single most interesting insider buy (or a cluster/roundup) from
 * filings discovered in the last 24 hours and drafts a ready-to-copy tweet.
 * Does NOT post — this is a draft generator only, emailed + written to disk
 * for manual review/posting.
 *
 * Freshness is judged by created_at (when WE scraped/discovered the filing),
 * not transaction_date (the actual trade date). MAR Article 19 allows T+3
 * disclosure, so transaction_date matches its scrape day on <1% of rows —
 * filtering on "transaction_date = today" leaves this empty on ~99% of runs.
 * The scraper runs at 06:00 and 14:00 UTC, so by the 17:30 UTC cron, every
 * filing discovered so far today is already in the DB; created_at >= 24h ago
 * reliably captures that regardless of how old the underlying trade is. Tweet
 * copy says "today" only when the picked row's transaction_date is actually
 * today, else "recently" — see dayPhraseFor().
 *
 * Runs ONLY on its own dedicated cron — do not also call this from
 * run-daily.sh's 06:00/14:00 UTC runs, which would draft off stale data and
 * send duplicate emails before the day's filings are in.
 *
 * Cron (Hetzner, 17:30 UTC Mon–Fri, ready to post at 18:00 UTC):
 *   30 17 * * 1-5 cd /opt/insider-tracker && node scrapers/social/generate-tweet.js >> logs/tweet-$(date +\%Y-\%m-\%d).txt 2>&1
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL   = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY   = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL        = 'jcdeboer@yahoo.com';
const FROM_EMAIL      = 'hello@insidersalpha.com';
const BASE_URL        = 'https://www.insidersalpha.com';
const OUT_FILE        = '/tmp/daily-tweet.txt';
const MAX_CHARS       = 280;
const MIN_VALUE_EUR   = 25000;
const MIN_CSUITE_EUR  = 50000;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Reference data ───────────────────────────────────────────────────────────

const COUNTRY_FLAGS = {
  DE: '🇩🇪', FR: '🇫🇷', GB: '🇬🇧', SE: '🇸🇪',
  NO: '🇳🇴', DK: '🇩🇰', FI: '🇫🇮', NL: '🇳🇱',
  BE: '🇧🇪', ES: '🇪🇸', IT: '🇮🇹', CH: '🇨🇭',
  PT: '🇵🇹', LU: '🇱🇺', PL: '🇵🇱', KR: '🇰🇷',
};

const COUNTRY_NAMES = {
  DE: 'Germany', FR: 'France', GB: 'United Kingdom', SE: 'Sweden',
  NO: 'Norway', DK: 'Denmark', FI: 'Finland', NL: 'Netherlands',
  BE: 'Belgium', ES: 'Spain', IT: 'Italy', CH: 'Switzerland',
  PT: 'Portugal', LU: 'Luxembourg', PL: 'Poland', KR: 'South Korea',
};

// Market-page slugs — must match the live routes in frontend/vercel.json
// (note: GB's page is "united-kingdom", not "uk").
const COUNTRY_SLUGS = {
  DE: 'germany', FR: 'france', GB: 'united-kingdom',
  SE: 'sweden', NO: 'norway', DK: 'denmark',
  FI: 'finland', NL: 'netherlands', BE: 'belgium',
  ES: 'spain', IT: 'italy', PT: 'portugal',
  LU: 'luxembourg', PL: 'poland', KR: 'south-korea',
};

// Fallback currency by country, used only when a row has no `currency` value.
const CURRENCY_BY_COUNTRY = {
  DE: 'EUR', FR: 'EUR', ES: 'EUR', BE: 'EUR', NL: 'EUR',
  FI: 'EUR', PT: 'EUR', LU: 'EUR', IT: 'EUR',
  NO: 'NOK', SE: 'SEK', DK: 'DKK', GB: 'GBP', KR: 'KRW', PL: 'PLN', CH: 'CHF',
};

// Static approximate EUR conversion rates — good enough for a >=25k threshold
// check, not for financial reporting. Update occasionally if rates drift a lot.
const FX_TO_EUR = {
  EUR: 1, GBP: 1.17, SEK: 0.088, NOK: 0.086,
  DKK: 0.134, PLN: 0.235, KRW: 0.00068, CHF: 1.04,
};

const CURRENCY_SYMBOLS = {
  EUR: '€', GBP: '£', SEK: 'SEK ', NOK: 'NOK ',
  DKK: 'DKK ', PLN: 'PLN ', KRW: '₩', CHF: 'CHF ',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strips a Yahoo-style exchange suffix if one is ever present on a ticker
// (insider_transactions.ticker is normally stored bare, e.g. "RHM" not
// "RHM.DE" — this is a defensive normalize, not the common case).
const EXCHANGE_SUFFIX_RE = /\.(ST|OL|CO|HE|AS|BR|PA|DE|L|MI|MC|WA|KS|KQ|SW|LU|AT|F)$/i;

function getCashtag(ticker) {
  if (!ticker) return '';
  const clean = ticker.replace(EXCHANGE_SUFFIX_RE, '').toUpperCase();
  return clean ? `$${clean}` : '';
}

function currencyOf(row) {
  return row.currency || CURRENCY_BY_COUNTRY[row.country_code] || 'EUR';
}

function eurValue(row) {
  const rate = FX_TO_EUR[currencyOf(row)] ?? 1;
  return Math.abs(Number(row.total_value || 0)) * rate;
}

function formatValue(value, currency) {
  const sym = CURRENCY_SYMBOLS[currency] || '€';
  const v = Math.abs(Number(value || 0));
  if (v >= 1000000) return sym + (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return sym + Math.round(v / 1000) + 'K';
  return sym + Math.round(v);
}

function formatPrice(price, currency) {
  const sym = CURRENCY_SYMBOLS[currency] || '€';
  const v = Number(price || 0);
  if (v >= 1000) return sym + Math.round(v).toLocaleString('en');
  if (v >= 10) return sym + v.toFixed(1);
  return sym + v.toFixed(2);
}

function simplifyRole(role) {
  if (!role) return 'Insider';
  const r = role.toLowerCase();
  if (r.includes('chief executive') || r.includes('ceo')) return 'CEO';
  if (r.includes('chief financial') || r.includes('cfo')) return 'CFO';
  if (r.includes('chief operating') || r.includes('coo')) return 'COO';
  if (r.includes('chairman')) return 'Chairman';
  if (r.includes('president')) return 'President';
  if (r.includes('director')) return 'Director';
  if (r.includes('board')) return 'Director';
  if (r.includes('member')) return 'Director';
  return 'Insider';
}

const ROLE_ABBR = { CEO: 'CEO', CFO: 'CFO', COO: 'COO', Chairman: 'Chair', President: 'Pres', Director: 'Dir', Insider: 'Insider' };

function shortCompanyName(name) {
  return (name || '').trim().split(/\s+/)[0] || name;
}

// ── DB query ──────────────────────────────────────────────────────────────────

// Freshness = discovered (created_at) in the last 24h, not transaction_date.
// The scraper runs at 06:00 and 14:00 UTC, so by the 17:30 UTC cron every
// filing found so far today is already in the DB — this reliably surfaces
// them regardless of how old the underlying trade is. Note: total_value is
// filtered in JS via eurValue() (EUR-equivalent conversion), not here, since
// a raw "total_value >= 25000" DB filter would apply a wildly different real
// threshold across currencies (25000 SEK is not 25000 EUR).
async function fetchRecentBuys() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from('insider_transactions')
    .select('id,company,ticker,country_code,transaction_date,insider_name,insider_role,price_per_share,total_value,currency,is_price_dip,price_drawdown')
    .gte('created_at', since)
    .eq('transaction_type', 'BUY')
    .eq('is_unusual_price', false)
    .gt('price_per_share', 0)
    .not('insider_name', 'is', null)
    .neq('country_code', 'CH')
    .order('total_value', { ascending: false });
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data || [];
}

// "today" is only accurate in the tweet copy when the picked row's actual
// transaction_date is today — otherwise say "recently" rather than assert a
// same-day claim the underlying filing doesn't support.
function dayPhraseFor(rows, todayStr) {
  const list = Array.isArray(rows) ? rows : [rows];
  return list.every(r => r.transaction_date === todayStr) ? 'today' : 'recently';
}

// ── Tier selection ───────────────────────────────────────────────────────────

function pickCluster(candidates) {
  const groups = new Map();
  for (const r of candidates) {
    const key = `${r.ticker || r.company}|${r.country_code}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const insiders = groups.get(key);
    // Keep each insider's single largest qualifying buy for the day.
    const existing = insiders.get(r.insider_name);
    if (!existing || eurValue(r) > eurValue(existing)) insiders.set(r.insider_name, r);
  }

  let best = null;
  for (const insiders of groups.values()) {
    if (insiders.size < 3) continue;
    const rows = [...insiders.values()].sort((a, b) => eurValue(b) - eurValue(a));
    const totalEur = rows.reduce((s, r) => s + eurValue(r), 0);
    if (!best || rows.length > best.rows.length ||
        (rows.length === best.rows.length && totalEur > best.totalEur)) {
      best = { rows, totalEur };
    }
  }
  return best ? best.rows : null;
}

function pickCsuite(candidates) {
  const eligible = candidates.filter(r =>
    ['CEO', 'CFO', 'Chairman'].includes(simplifyRole(r.insider_role)) && eurValue(r) > MIN_CSUITE_EUR
  );
  if (!eligible.length) return null;
  return eligible.reduce((best, r) => (eurValue(r) > eurValue(best) ? r : best));
}

function pickPriceDip(candidates) {
  const eligible = candidates.filter(r => r.is_price_dip === true && eurValue(r) > MIN_VALUE_EUR);
  if (!eligible.length) return null;
  return eligible.reduce((best, r) => (eurValue(r) > eurValue(best) ? r : best));
}

function pickCountryRoundup(candidates) {
  const distinctCountries = new Set(candidates.map(r => r.country_code));
  if (distinctCountries.size < 3) return null;
  const sorted = [...candidates].sort((a, b) => eurValue(b) - eurValue(a));
  const picked = [];
  const usedCountries = new Set();
  for (const r of sorted) {
    if (usedCountries.has(r.country_code)) continue;
    picked.push(r);
    usedCountries.add(r.country_code);
    if (picked.length === 3) break;
  }
  return picked.length >= 3 ? picked : null;
}

function pickHighestValue(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, r) => (eurValue(r) > eurValue(best) ? r : best));
}

// ── Tweet builders ────────────────────────────────────────────────────────────
// Each builder takes a `level` (0-4) controlling progressive shortening so the
// tweet fits MAX_CHARS: 1=short company name, 2=+drop cashtag, 3=+abbreviate
// role, 4=+drop one cluster bullet. URL is never removed.

function companyFor(row, level) {
  return level >= 1 ? shortCompanyName(row.company) : row.company;
}
function roleFor(role, level) {
  return level >= 3 ? ROLE_ABBR[role] || role : role;
}

// "18 Jul" — short enough to always keep, even under the char-limit pipeline.
function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDate();
  const month = d.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  return `${day} ${month}`;
}

// Only show the date when it isn't today — a same-day filing doesn't need
// one, and this keeps single-transaction tweets from stating the obvious.
function dateSuffix(row, todayStr) {
  return row.transaction_date === todayStr ? '' : ` · ${shortDate(row.transaction_date)}`;
}

function buildFormatA(rows, ctry, dayPhrase, level) {
  const flag = COUNTRY_FLAGS[ctry] || '';
  const countryName = COUNTRY_NAMES[ctry] || ctry;
  const company = companyFor(rows[0], level);
  const shown = level >= 4 ? rows.slice(0, Math.max(2, rows.length - 1)) : rows;
  const bullets = shown.map(r => {
    const role = roleFor(simplifyRole(r.insider_role), level);
    return `- ${r.insider_name} (${role}): ${formatValue(r.total_value, currencyOf(r))}`;
  }).join('\n');
  return `🔄 Cluster buy — ${flag} ${countryName}\n\n${rows.length} insiders at ${company} bought ${dayPhrase}:\n${bullets}\n\ninsidersalpha.com`;
}

function buildFormatB(row, level, todayStr) {
  const flag = COUNTRY_FLAGS[row.country_code] || '';
  const countryName = COUNTRY_NAMES[row.country_code] || row.country_code;
  const role = roleFor(simplifyRole(row.insider_role), level);
  const company = companyFor(row, level);
  const currency = currencyOf(row);
  const cashtagText = getCashtag(row.ticker);
  const cashtag = level >= 2 || !cashtagText ? '' : ` ${cashtagText}`;
  const slug = COUNTRY_SLUGS[row.country_code];
  const link = slug ? `insidersalpha.com/market/${slug}-insider-transactions` : 'insidersalpha.com';
  return `${flag} ${role} buy — ${countryName}\n\n${company}${cashtag}\n${row.insider_name} (${role}) bought ${formatValue(row.total_value, currency)}\n@ ${formatPrice(row.price_per_share, currency)}/share${dateSuffix(row, todayStr)}\n\n${link}`;
}

function buildFormatC(row, level, todayStr) {
  const flag = COUNTRY_FLAGS[row.country_code] || '';
  const role = roleFor(simplifyRole(row.insider_role), level);
  const company = companyFor(row, level);
  const drawdownPct = row.price_drawdown != null ? Math.round(Number(row.price_drawdown) * 100) : null;
  const drawdownLine = drawdownPct != null ? `${company} down ${drawdownPct}% in 90 days` : `${company} bought after a price decline`;
  return `📉 Buying the dip — ${flag}\n\n${drawdownLine}\n${role} just bought ${formatValue(row.total_value, currencyOf(row))}${dateSuffix(row, todayStr)}\n\ninsidersalpha.com`;
}

function buildFormatD(rows, dayPhrase, level) {
  const flags = rows.map(r => COUNTRY_FLAGS[r.country_code] || '').join('');
  const lines = rows.map(r => {
    const flag = COUNTRY_FLAGS[r.country_code] || '';
    const role = roleFor(simplifyRole(r.insider_role), level);
    const company = companyFor(r, level);
    return `${flag} ${company} — ${role} bought ${formatValue(r.total_value, currencyOf(r))}`;
  }).join('\n');
  return `${flags} European insider transactions ${dayPhrase}\n\n${lines}\n\ninsidersalpha.com`;
}

// Try progressively shorter renders of `builder(level)` until it fits, or give
// up and return the most-shortened version we have.
function fitToLimit(builder, maxLevel = 4) {
  let last = builder(0);
  for (let level = 0; level <= maxLevel; level++) {
    const text = builder(level);
    last = text;
    if (text.length <= MAX_CHARS) return text;
  }
  return last;
}

// ── Email ─────────────────────────────────────────────────────────────────────

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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTweetEmailHtml(tweetText, charCount, dateStr) {
  return `
<!DOCTYPE html><html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111318">
  <h2 style="font-size:17px;font-weight:700;margin:0 0 4px">📊 InsidersAlpha Daily Tweet</h2>
  <p style="color:#6B7280;font-size:13px;margin:0 0 20px">${dateStr} · ${charCount}/${MAX_CHARS} characters · ready to post at 18:00 UTC</p>
  <pre style="white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:14px;line-height:1.6;background:#f8f8f8;border:1px solid #f0f0f0;border-radius:8px;padding:16px;color:#111318">${escapeHtml(tweetText)}</pre>
  <p style="font-size:11px;color:#9CA3AF;margin-top:20px">Auto-generated · InsidersAlpha</p>
</body></html>`.trim();
}

function buildEmptyEmailHtml(dateStr) {
  return `
<!DOCTYPE html><html><body style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111318">
  <h2 style="font-size:17px;font-weight:700;margin:0 0 4px">📊 InsidersAlpha Daily Tweet</h2>
  <p style="color:#6B7280;font-size:13px;margin:0 0 20px">${dateStr}</p>
  <p style="font-size:14px;color:#374151">No insider transactions above €25,000 found for today. Check back tomorrow.</p>
</body></html>`.trim();
}

// When the picked transaction (Format B/C only — single company/role) is
// dated before today, the subject says so up front, so opening the email
// doesn't imply a same-day trade the filing doesn't support. Formats A/D
// pick multiple rows with no single company to name and keep the generic
// subject; so does the "dated today" case, where there's nothing to clarify.
function buildEmailSubject(subjectRow, dateStr, todayStr) {
  if (subjectRow && subjectRow.transaction_date && subjectRow.transaction_date !== todayStr) {
    const role = simplifyRole(subjectRow.insider_role);
    return `📊 Newly disclosed: ${subjectRow.company} ${role} buy · ${shortDate(subjectRow.transaction_date)}`;
  }
  return `📊 InsidersAlpha Daily Tweet - ${dateStr}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  console.log(`\n── Daily Tweet Generator ─────────────────────────────`);
  console.log(`  Date: ${today}`);

  const rows = await fetchRecentBuys();
  const candidates = rows.filter(r => eurValue(r) >= MIN_VALUE_EUR);
  console.log(`  Rows fetched (discovered in last 24h): ${rows.length}, qualifying (>=€${MIN_VALUE_EUR.toLocaleString('en')}): ${candidates.length}`);

  const dateStr = today;

  if (!candidates.length) {
    console.log('No significant insider transactions today.');

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, 'No significant insider transactions today.', 'utf8');

    await sendResendEmail('📊 InsidersAlpha - No significant transactions today', buildEmptyEmailHtml(dateStr));
    return;
  }

  let tweet;
  // Only set for single-transaction formats (B, C) — used to build a subject
  // line naming the actual company/role/date when that date isn't today.
  // Formats A/D pick multiple rows with no single company to name in a
  // subject, so they keep the generic subject.
  let subjectRow = null;

  const cluster = pickCluster(candidates);
  if (cluster) {
    console.log(`  → Format A (cluster): ${cluster.length} insiders at ${cluster[0].company}`);
    tweet = fitToLimit(level => buildFormatA(cluster, cluster[0].country_code, dayPhraseFor(cluster, today), level));
  } else {
    const csuite = pickCsuite(candidates);
    if (csuite) {
      console.log(`  → Format B (C-suite): ${csuite.insider_name} @ ${csuite.company}`);
      tweet = fitToLimit(level => buildFormatB(csuite, level, today));
      subjectRow = csuite;
    } else {
      const dip = pickPriceDip(candidates);
      if (dip) {
        console.log(`  → Format C (price dip): ${dip.company}`);
        tweet = fitToLimit(level => buildFormatC(dip, level, today));
        subjectRow = dip;
      } else {
        const roundup = pickCountryRoundup(candidates);
        if (roundup) {
          console.log(`  → Format D (country roundup): ${roundup.map(r => r.country_code).join(', ')}`);
          tweet = fitToLimit(level => buildFormatD(roundup, dayPhraseFor(roundup, today), level));
        } else {
          const top = pickHighestValue(candidates);
          console.log(`  → Format B (highest value): ${top.insider_name} @ ${top.company}`);
          tweet = fitToLimit(level => buildFormatB(top, level, today));
          subjectRow = top;
        }
      }
    }
  }

  const charCount = tweet.length;

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, tweet, 'utf8');

  console.log(`\n=== InsidersAlpha Daily Tweet (17:30 UTC) ===`);
  console.log(`Characters: ${charCount}/${MAX_CHARS}`);
  console.log(``);
  console.log(tweet);
  console.log(``);
  console.log(`================================\n`);

  const subject = buildEmailSubject(subjectRow, dateStr, today);
  console.log(`Subject: ${subject}\n`);
  await sendResendEmail(subject, buildTweetEmailHtml(tweet, charCount, dateStr));
}

if (require.main === module) {
  main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
}

module.exports = {
  pickCluster, pickCsuite, pickPriceDip, pickCountryRoundup, pickHighestValue,
  buildFormatA, buildFormatB, buildFormatC, buildFormatD, fitToLimit,
  eurValue, simplifyRole, formatValue, formatPrice, getCashtag, dayPhraseFor,
  shortDate, dateSuffix, buildEmailSubject,
};
