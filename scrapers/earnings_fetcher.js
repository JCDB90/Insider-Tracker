'use strict';
/**
 * Earnings Calendar Fetcher
 *
 * API reality after exhaustive testing (2026-04-24):
 *
 *  ┌─────────────────┬────────────────────────┬──────────────────────────┐
 *  │ Source          │ Free tier EU coverage  │ Notes                    │
 *  ├─────────────────┼────────────────────────┼──────────────────────────┤
 *  │ Finnhub (free)  │ ~15-25% (cross-listed) │ 403 on .AS/.DE/.PA etc.  │
 *  │                 │ bare tickers only       │ Works: ASML SAP ENI RACE │
 *  │                 │                         │ False pos: SAND→SSL.TO  │
 *  ├─────────────────┼────────────────────────┼──────────────────────────┤
 *  │ FMP (free)      │ 0%                     │ All v3 endpoints legacy  │
 *  │                 │                         │ Stable only global US    │
 *  ├─────────────────┼────────────────────────┼──────────────────────────┤
 *  │ Yahoo v10       │ Would be good           │ Crumb auth broken 2026   │
 *  ├─────────────────┼────────────────────────┼──────────────────────────┤
 *  │ Alpha Vantage   │ US-only calendar        │ No European tickers      │
 *  ├─────────────────┼────────────────────────┼──────────────────────────┤
 *  │ Euronext API    │ Returns empty arrays    │ Auth/session required    │
 *  └─────────────────┴────────────────────────┴──────────────────────────┘
 *
 * Strategy: Finnhub bare-ticker lookup with exchange-suffix validation
 * to reject false positives (e.g. SAND→SSL.TO instead of SAND.ST).
 * Expect ~15-25% coverage for cross-listed European companies (ASML,
 * SAP, ENI, EQNR, Santander, Ferrari, LVMH, etc.).
 *
 * For full European coverage, upgrade Finnhub to a paid plan (~$49/mo)
 * which allows exchange-specific symbols like ASML.AS, SAP.DE, etc.
 *
 * Usage:
 *   FINNHUB_API_KEY=your_key node scrapers/earnings_fetcher.js
 *
 * Requirements:
 *   - Run migrations/005_earnings_calendar.sql in Supabase dashboard first
 */

const https = require('https');
const { supabase } = require('./lib/db');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

const DELAY_MS = 220;       // gentle rate-limit between calls
const BATCH_SIZE = 60;      // pause every N tickers

// Primary exchange suffix per country (for validating Finnhub results)
const PRIMARY_SUFFIX = {
  NL:'.AS', FR:'.PA', DE:'.DE', GB:'.L',  SE:'.ST', DK:'.CO', FI:'.HE',
  NO:'.OL', BE:'.BR', PT:'.LS', IT:'.MI', ES:'.MC', AT:'.VI', CH:'.SW',
  PL:'.WA', IE:'.IR', LU:'.LU', CZ:'.PR', SG:'.SI', HK:'.HK', JP:'.T',
  KR:'.KS', AU:'.AX', ZA:'.JO', CA:'.TO',
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

/**
 * Strip exchange suffix from ticker to get the bare symbol Finnhub expects.
 * e.g. "INDU-C.ST" → "INDU-C", "SHB-A" → "SHB-A", "EQNR.OL" → "EQNR"
 */
function bareTicker(ticker) {
  return ticker.replace(/\.(AS|PA|DE|MI|OL|ST|CO|HE|BR|SW|VI|LS|MC|L|WA|IR|LU|PR|SI|HK|T|KS|AX|JO|TO|V|F)$/i, '');
}

/**
 * Fetch upcoming earnings from Finnhub for a bare ticker.
 * Validates that the returned symbol uses the expected exchange suffix for
 * the given country — prevents cross-exchange false positives (e.g. SAND→SSL.TO).
 *
 * Returns { dates, resolvedSymbol } or null.
 */
async function fetchFinnhub(ticker, countryCode, yahooOverride) {
  const today = new Date().toISOString().slice(0, 10);
  const to    = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);

  // Determine what exchange suffix we expect for this country
  const expectedSuffix = PRIMARY_SUFFIX[countryCode] || null;

  // Candidates to try: yahoo_ticker override first, then bare
  const candidates = [];
  if (yahooOverride) {
    candidates.push(bareTicker(yahooOverride));
    if (yahooOverride !== bareTicker(yahooOverride)) candidates.push(yahooOverride);
  }
  candidates.push(bareTicker(ticker));
  if (ticker !== bareTicker(ticker)) candidates.push(ticker);

  // Deduplicate
  const tried = new Set();
  for (const sym of candidates) {
    if (tried.has(sym)) continue;
    tried.add(sym);

    const url  = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${to}&symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`;
    const json = await getJson(url);
    if (!json?.earningsCalendar?.length) { await sleep(DELAY_MS); continue; }

    const entries = json.earningsCalendar;
    const resolvedSymbol = entries[0]?.symbol || sym;

    // Validate exchange suffix if we have an expectation
    if (expectedSuffix) {
      const resolvedSuffix = resolvedSymbol.match(/\.[A-Z]+$/)?.[0]?.toUpperCase();
      if (resolvedSuffix && resolvedSuffix !== expectedSuffix.toUpperCase()) {
        // Wrong exchange — likely a different company with the same ticker name
        await sleep(DELAY_MS);
        continue;
      }
    }

    const dates = entries.map(e => e.date).filter(Boolean).sort();
    return { dates, resolvedSymbol };
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📅  Earnings Calendar Fetcher (Finnhub, bare-ticker strategy)');

  if (!FINNHUB_KEY) {
    console.error('\n❌  No FINNHUB_API_KEY set.');
    console.error('   Register free at finnhub.io then set the env var:');
    console.error('   FINNHUB_API_KEY=your_key node scrapers/earnings_fetcher.js\n');
    console.error('   Note: free tier only covers ~15-25% of European tickers');
    console.error('   (cross-listed companies like ASML, SAP, ENI, EQNR, etc.)');
    console.error('   Upgrade to Finnhub paid plan for full European coverage.');
    process.exit(1);
  }

  // Verify table exists
  const { error: tableErr } = await supabase.from('earnings_calendar').select('ticker').limit(1);
  if (tableErr) {
    console.error('\n❌  earnings_calendar table not found.');
    console.error('   Run migrations/005_earnings_calendar.sql in Supabase dashboard first.\n');
    process.exit(1);
  }

  // Fetch all unique tickers from DB
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
  const overrides = new Map();
  for (const w of wl || []) if (w.yahoo_ticker) overrides.set(w.ticker, w.yahoo_ticker);

  const tickers = [...tickerMap.entries()];
  console.log(`  ${tickers.length} unique tickers\n`);

  const t0 = Date.now();
  let found = 0, rejected = 0, notFound = 0, upserted = 0;
  const pendingRows = [];
  const foundTickers = [];
  const noDataTickers = [];

  for (let i = 0; i < tickers.length; i++) {
    const [ticker, countryCode] = tickers[i];
    const result = await fetchFinnhub(ticker, countryCode, overrides.get(ticker) || null);

    if (result) {
      found++;
      foundTickers.push(`${ticker}→${result.resolvedSymbol}`);
      const next = result.dates.find(d => d >= new Date().toISOString().slice(0,10));
      if (i < 10 || (i+1) % 50 === 0) {
        console.log(`  ✓ [${String(i+1).padStart(3)}] ${ticker.padEnd(12)} → ${result.resolvedSymbol.padEnd(12)} | ${result.dates.join(', ')}${next ? ' ← next' : ''}`);
      }
      for (const d of result.dates) {
        pendingRows.push({ ticker, country_code: countryCode, earnings_date: d, source: 'finnhub' });
      }
    } else {
      notFound++;
      noDataTickers.push(ticker);
    }

    // Flush every 50 rows
    if (pendingRows.length >= 50) {
      const { error } = await supabase.from('earnings_calendar')
        .upsert(pendingRows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠  upsert error:', error.message);
      else upserted += pendingRows.length;
      pendingRows.length = 0;
    }

    if ((i+1) % BATCH_SIZE === 0) {
      console.log(`  [${i+1}/${tickers.length}] found: ${found}, notFound: ${notFound}`);
      await sleep(1500);
    } else {
      await sleep(DELAY_MS);
    }
  }

  // Flush remainder
  if (pendingRows.length > 0) {
    const { error } = await supabase.from('earnings_calendar')
      .upsert(pendingRows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
    if (error) console.error('  ⚠  upsert error:', error.message);
    else upserted += pendingRows.length;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const pct  = Math.round(found / tickers.length * 100);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  Done in ${secs}s`);
  console.log(`  Coverage: ${found}/${tickers.length} tickers (${pct}%)`);
  console.log(`  Earnings dates upserted: ${upserted}`);
  if (rejected) console.log(`  Exchange-validation rejects: ${rejected} (false positives avoided)`);
  console.log(`\n  Covered tickers (${found}):`);
  console.log('  ' + foundTickers.join(', '));
  console.log(`\n  No data (${noDataTickers.length}) — European-only tickers not cross-listed on US markets:`);
  // Group by country
  const byCountry = {};
  for (const t of noDataTickers) {
    const cc = tickerMap.get(t) || '??';
    (byCountry[cc] = byCountry[cc] || []).push(t);
  }
  for (const [cc, ts] of Object.entries(byCountry).sort()) {
    console.log(`  [${cc}] ${ts.join(', ')}`);
  }
  console.log(`\n  Note: For full European coverage, upgrade Finnhub to paid plan.`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
