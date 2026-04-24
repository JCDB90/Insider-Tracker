'use strict';
/**
 * Earnings Calendar Fetcher
 *
 * Fetches upcoming and recent earnings dates from Yahoo Finance for every
 * unique ticker in insider_transactions, then upserts into earnings_calendar.
 *
 * Run weekly via GitHub Actions (.github/workflows/earnings-weekly.yml).
 * Also safe to run manually: node scrapers/earnings_fetcher.js
 *
 * Requires migration 005_earnings_calendar.sql to be run first.
 */

const https = require('https');
const { supabase } = require('./lib/db');

const DELAY_MS   = 220;   // gentle rate-limit between Yahoo calls
const BATCH_SIZE = 50;    // tickers per batch before a longer pause

const EXCHANGE_SUFFIXES = {
  NL: ['.AS', '.PA'],
  FR: ['.PA', '.AS'],
  DE: ['.DE', '.F'],
  GB: ['.L'],
  SE: ['.ST'],
  DK: ['.CO'],
  FI: ['.HE'],
  NO: ['.OL'],
  BE: ['.BR', '.PA'],
  PT: ['.LS'],
  IT: ['.MI'],
  ES: ['.MC'],
  AT: ['.VI'],
  CH: ['.SW'],
  PL: ['.WA'],
  IE: ['.IR'],
  LU: ['.LU'],
  CZ: ['.PR'],
  SG: ['.SI'],
  HK: ['.HK'],
  JP: ['.T'],
  KR: ['.KS'],
  AU: ['.AX'],
  ZA: ['.JO'],
  CA: ['.TO', '.V'],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchCalendar(symbol) {
  return new Promise(resolve => {
    const path = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents`;
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Extract earnings dates from a Yahoo Finance quoteSummary response.
 * Returns array of YYYY-MM-DD strings, or [] if none found.
 */
function parseEarningsDates(json) {
  if (!json) return [];
  const result = json?.quoteSummary?.result?.[0];
  if (!result) return [];
  const calendar = result.calendarEvents;
  if (!calendar) return [];

  const dates = [];
  const earningsArr = calendar.earnings?.earningsDate || [];
  for (const e of earningsArr) {
    const ts = e?.raw ?? e;
    if (ts && typeof ts === 'number' && ts > 0) {
      dates.push(new Date(ts * 1000).toISOString().slice(0, 10));
    }
  }
  return [...new Set(dates)].sort();
}

/**
 * Try multiple Yahoo Finance symbols for a ticker until we get earnings dates.
 * Returns { symbol, dates } or null.
 */
async function fetchWithFallbacks(ticker, countryCode, yahooOverride) {
  const candidates = [];

  // Watchlist yahoo_ticker takes priority
  if (yahooOverride) candidates.push(yahooOverride);

  // Country-specific suffixes
  const suffixes = EXCHANGE_SUFFIXES[countryCode] || [''];
  for (const s of suffixes) candidates.push(ticker + s);
  // Bare ticker as last resort
  if (!suffixes.includes('')) candidates.push(ticker);

  for (const symbol of candidates) {
    const json  = await fetchCalendar(symbol);
    const dates = parseEarningsDates(json);
    if (dates.length > 0) return { symbol, dates };
    await sleep(DELAY_MS);
  }
  return null;
}

async function main() {
  console.log('📅  Earnings Calendar Fetcher');
  const t0 = Date.now();

  // ── Check table exists ────────────────────────────────────────────────────
  const { error: tableErr } = await supabase.from('earnings_calendar').select('ticker').limit(1);
  if (tableErr) {
    console.error('❌  earnings_calendar table not found.');
    console.error('   Run migrations/005_earnings_calendar.sql in your Supabase dashboard first.');
    process.exit(1);
  }

  // ── Fetch distinct tickers ────────────────────────────────────────────────
  const { data: txRows } = await supabase
    .from('insider_transactions')
    .select('ticker,country_code')
    .not('ticker', 'is', null)
    .neq('ticker', '');

  // Build unique (ticker, country_code) map — keep first country seen
  const tickerMap = new Map();
  for (const r of txRows || []) {
    if (!tickerMap.has(r.ticker)) tickerMap.set(r.ticker, r.country_code);
  }

  // Overlay yahoo_ticker overrides from watchlist
  const { data: wl } = await supabase.from('watchlist').select('ticker,country_code,yahoo_ticker');
  const yahooOverrides = new Map();
  for (const w of wl || []) {
    if (w.yahoo_ticker) yahooOverrides.set(w.ticker, w.yahoo_ticker);
  }

  const tickers = [...tickerMap.entries()]; // [[ticker, country_code], ...]
  console.log(`  ${tickers.length} unique tickers to process`);

  // ── Process in batches ────────────────────────────────────────────────────
  let found = 0, notFound = 0, upserted = 0;
  const rows = [];

  for (let i = 0; i < tickers.length; i++) {
    const [ticker, countryCode] = tickers[i];
    const yahooOverride = yahooOverrides.get(ticker) || null;

    const result = await fetchWithFallbacks(ticker, countryCode, yahooOverride);

    if (result) {
      found++;
      for (const d of result.dates) {
        rows.push({ ticker, country_code: countryCode, earnings_date: d, source: 'yahoo' });
      }
      if (i < 5 || i % 50 === 0) {
        console.log(`  ✓ ${ticker} (${countryCode}) via ${result.symbol}: ${result.dates.join(', ')}`);
      }
    } else {
      notFound++;
    }

    // Batch-flush every 50 successful rows
    if (rows.length >= 50) {
      const { error } = await supabase
        .from('earnings_calendar')
        .upsert(rows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠ upsert error:', error.message);
      else upserted += rows.length;
      rows.length = 0;
    }

    // Longer pause every BATCH_SIZE tickers
    if ((i + 1) % BATCH_SIZE === 0) {
      console.log(`  Progress: ${i + 1}/${tickers.length} — found: ${found}, not found: ${notFound}`);
      await sleep(1000);
    } else {
      await sleep(DELAY_MS);
    }
  }

  // Flush remainder
  if (rows.length > 0) {
    const { error } = await supabase
      .from('earnings_calendar')
      .upsert(rows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
    if (error) console.error('  ⚠ upsert error:', error.message);
    else upserted += rows.length;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅  Done in ${secs}s — coverage: ${found}/${tickers.length} tickers (${Math.round(found/tickers.length*100)}%)`);
  console.log(`   Upserted ${upserted} earnings dates`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
