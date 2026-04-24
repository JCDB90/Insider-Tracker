'use strict';
/**
 * Earnings Calendar Fetcher
 *
 * Fetches upcoming/historical earnings dates and upserts into earnings_calendar.
 *
 * Source priority (set via env vars):
 *   1. Finnhub  — FINNHUB_API_KEY  (recommended: best European coverage, 60 req/min free)
 *   2. FMP      — FMP_API_KEY      (fallback: 250 req/day free, good for mid/large caps)
 *
 * Free API keys (no credit card required):
 *   Finnhub:  https://finnhub.io/register
 *   FMP:      https://site.financialmodelingprep.com/register
 *
 * Requires migration 005_earnings_calendar.sql to be run first.
 *
 * Usage:
 *   FINNHUB_API_KEY=your_key node scrapers/earnings_fetcher.js
 *   FMP_API_KEY=your_key node scrapers/earnings_fetcher.js
 */

const https = require('https');
const { supabase } = require('./lib/db');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const FMP_KEY     = process.env.FMP_API_KEY     || '';

const DELAY_MS = 250;   // between individual ticker calls
const BATCH_PAUSE_MS = 2000; // longer pause every 50 tickers

const EXCHANGE_SUFFIXES = {
  NL:['.AS','.PA'], FR:['.PA','.AS'], DE:['.DE','.F'], GB:['.L'],
  SE:['.ST'],       DK:['.CO'],       FI:['.HE'],      NO:['.OL'],
  BE:['.BR','.PA'], PT:['.LS'],       IT:['.MI'],       ES:['.MC'],
  AT:['.VI'],       CH:['.SW'],       PL:['.WA'],       IE:['.IR'],
  LU:['.LU'],       CZ:['.PR'],       SG:['.SI'],       HK:['.HK'],
  JP:['.T'],        KR:['.KS'],       AU:['.AX'],       ZA:['.JO'],
  CA:['.TO','.V'],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
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

// ── Finnhub ────────────────────────────────────────────────────────────────

async function fetchFinnhubEarnings(symbol) {
  if (!FINNHUB_KEY) return [];
  // Use symbol-specific endpoint (date range ±18 months around today)
  const from = new Date(); from.setMonth(from.getMonth() - 18);
  const to   = new Date(); to.setMonth(to.getMonth()   + 18);
  const fmt  = d => d.toISOString().slice(0, 10);

  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}&symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
  const json = await getJson(url);
  if (!json?.earningsCalendar) return [];
  return json.earningsCalendar
    .map(r => r.date)
    .filter(Boolean)
    .sort();
}

// ── FMP ────────────────────────────────────────────────────────────────────

async function fetchFmpEarnings(symbol) {
  if (!FMP_KEY) return [];
  const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${encodeURIComponent(symbol)}?limit=8&apikey=${FMP_KEY}`;
  const json = await getJson(url);
  if (!Array.isArray(json) || json.length === 0) return [];
  return json
    .map(r => r.date)
    .filter(Boolean)
    .sort()
    .reverse()
    .slice(0, 8);
}

// ── Combined fetch with symbol fallbacks ───────────────────────────────────

async function fetchEarningsForTicker(ticker, countryCode, yahooOverride) {
  const candidates = [];
  if (yahooOverride) candidates.push(yahooOverride);
  const suffixes = EXCHANGE_SUFFIXES[countryCode] || [''];
  for (const s of suffixes) candidates.push(ticker + s);
  if (!suffixes.includes('')) candidates.push(ticker);

  for (const symbol of candidates) {
    // Try Finnhub first (best EU coverage)
    let dates = await fetchFinnhubEarnings(symbol);
    if (dates.length > 0) return { symbol, source: 'finnhub', dates };
    if (FINNHUB_KEY) await sleep(DELAY_MS);

    // Fallback to FMP
    dates = await fetchFmpEarnings(symbol);
    if (dates.length > 0) return { symbol, source: 'fmp', dates };
    if (FMP_KEY) await sleep(DELAY_MS);
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📅  Earnings Calendar Fetcher');

  if (!FINNHUB_KEY && !FMP_KEY) {
    console.error('\n❌  No API key found. Set one of:');
    console.error('   FINNHUB_API_KEY=your_key  (recommended — register free at finnhub.io)');
    console.error('   FMP_API_KEY=your_key      (fallback    — register free at financialmodelingprep.com)');
    process.exit(1);
  }

  const source = FINNHUB_KEY ? 'Finnhub' : 'FMP';
  console.log(`  Source: ${source}${FINNHUB_KEY && FMP_KEY ? ' + FMP fallback' : ''}`);

  // Check table exists
  const { error: tableErr } = await supabase.from('earnings_calendar').select('ticker').limit(1);
  if (tableErr) {
    console.error('\n❌  earnings_calendar table not found.');
    console.error('   Run migrations/005_earnings_calendar.sql in your Supabase dashboard first.');
    process.exit(1);
  }

  // Get distinct tickers
  const { data: txRows } = await supabase
    .from('insider_transactions')
    .select('ticker,country_code')
    .not('ticker', 'is', null)
    .neq('ticker', '');

  const tickerMap = new Map();
  for (const r of txRows || []) {
    if (!tickerMap.has(r.ticker)) tickerMap.set(r.ticker, r.country_code);
  }

  // Watchlist yahoo_ticker overrides
  const { data: wl } = await supabase.from('watchlist').select('ticker,country_code,yahoo_ticker');
  const yahooOverrides = new Map();
  for (const w of wl || []) if (w.yahoo_ticker) yahooOverrides.set(w.ticker, w.yahoo_ticker);

  const tickers = [...tickerMap.entries()];
  console.log(`  ${tickers.length} unique tickers\n`);

  const t0 = Date.now();
  let found = 0, notFound = 0, upserted = 0;
  const rows = [];
  const sourceCounts = { finnhub: 0, fmp: 0 };

  for (let i = 0; i < tickers.length; i++) {
    const [ticker, countryCode] = tickers[i];
    const result = await fetchEarningsForTicker(
      ticker, countryCode, yahooOverrides.get(ticker) || null
    );

    if (result) {
      found++;
      sourceCounts[result.source] = (sourceCounts[result.source] || 0) + 1;
      for (const d of result.dates) {
        rows.push({ ticker, country_code: countryCode, earnings_date: d, source: result.source });
      }
      if (i < 5 || (i + 1) % 50 === 0) {
        const next = result.dates.find(d => d >= new Date().toISOString().slice(0, 10));
        console.log(`  ✓ [${String(i+1).padStart(3)}] ${ticker} (${countryCode}) → ${result.dates.length} dates via ${result.symbol}${next ? ' · next: '+next : ''}`);
      }
    } else {
      notFound++;
    }

    // Flush to DB every 50 collected rows
    if (rows.length >= 50) {
      const { error } = await supabase
        .from('earnings_calendar')
        .upsert(rows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠  upsert error:', error.message);
      else upserted += rows.length;
      rows.length = 0;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [${i+1}/${tickers.length}] found: ${found}, not found: ${notFound}`);
      await sleep(BATCH_PAUSE_MS);
    } else {
      await sleep(DELAY_MS);
    }
  }

  // Flush remainder
  if (rows.length > 0) {
    const { error } = await supabase
      .from('earnings_calendar')
      .upsert(rows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
    if (error) console.error('  ⚠  upsert error:', error.message);
    else upserted += rows.length;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const coverage = Math.round(found / tickers.length * 100);
  console.log(`\n✅  ${secs}s — coverage: ${found}/${tickers.length} (${coverage}%) · upserted ${upserted} dates`);
  if (sourceCounts.finnhub) console.log(`   Finnhub: ${sourceCounts.finnhub} tickers`);
  if (sourceCounts.fmp)     console.log(`   FMP:     ${sourceCounts.fmp} tickers`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
