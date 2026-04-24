'use strict';
/**
 * Earnings Calendar Fetcher — multi-source, market-aware
 *
 * Sources by market (ALL FREE, no API key for exchanges):
 *
 *  Norway (NO)  — Oslo Bors newsreader API (cat 1001=Annual, 1002=Interim)
 *                 Fetch 2-year history → extract real dates → predict next
 *                 from each company's cadence. Coverage: ~100% of NO tickers.
 *
 *  Other mkts   — Finnhub calendar (FINNHUB_API_KEY) with bare-ticker +
 *                 exchange-suffix validation. ~1-5% EU coverage on free tier.
 *
 * European exchange calendar APIs tested and confirmed non-functional
 * without paid access:
 *   Euronext (NL/FR/BE/PT) — aaData always empty, requires browser session
 *   Nasdaq Nordic (SE/DK/FI) — redirects to US site
 *   Boerse Frankfurt (DE)    — returns empty calendar
 *   Borsa Italiana (IT)      — no public calendar API
 *
 * Usage:
 *   node scrapers/earnings_fetcher.js
 *   FINNHUB_API_KEY=xxx node scrapers/earnings_fetcher.js
 */

const https = require('https');
const { supabase } = require('./lib/db');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const OSLO_BASE   = 'https://api3.oslo.oslobors.no';
const OSLO_ORIGIN = 'https://newsweb.oslobors.no';

const DELAY_MS = 220;

// Primary exchange suffix per country (for Finnhub result validation)
const PRIMARY_SUFFIX = {
  NL:'.AS', FR:'.PA', DE:'.DE', GB:'.L',  SE:'.ST', DK:'.CO', FI:'.HE',
  NO:'.OL', BE:'.BR', PT:'.LS', IT:'.MI', ES:'.MC', AT:'.VI', CH:'.SW',
  PL:'.WA', IE:'.IR', LU:'.LU', CZ:'.PR', SG:'.SI', HK:'.HK', JP:'.T',
  KR:'.KS', AU:'.AX', ZA:'.JO', CA:'.TO',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers },
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

// ── Oslo Bors: fetch all financial report filings ─────────────────────────

async function fetchOsloBorsReportDates() {
  const past2y = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const in12m  = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const today  = new Date().toISOString().slice(0, 10);

  const tickerDates = new Map(); // ticker → Set<dateStr>

  for (const cat of [1001, 1002]) {
    // Past 2 years
    const pastJson = await getJson(
      `${OSLO_BASE}/v1/newsreader/list?category=${cat}&fromDate=${past2y}&toDate=${today}`,
      { 'Origin': OSLO_ORIGIN, 'Referer': OSLO_ORIGIN + '/' }
    );
    // Future (already-announced upcoming reports)
    const futureJson = await getJson(
      `${OSLO_BASE}/v1/newsreader/list?category=${cat}&fromDate=${today}&toDate=${in12m}`,
      { 'Origin': OSLO_ORIGIN, 'Referer': OSLO_ORIGIN + '/' }
    );
    await sleep(300);

    for (const json of [pastJson, futureJson]) {
      for (const m of (json?.data?.messages || [])) {
        const ticker = m.issuerSign?.trim();
        const date   = (m.publishedTime || m.time || '').slice(0, 10);
        if (!ticker || !date) continue;
        if (!tickerDates.has(ticker)) tickerDates.set(ticker, new Set());
        tickerDates.get(ticker).add(date);
      }
    }
  }
  return tickerDates;
}

/**
 * Given a set of historical dates for one company, return:
 *  - all confirmed past dates
 *  - one predicted future date (based on average cadence)
 */
function predictNextDate(dates) {
  const sorted = [...dates].sort();
  const past   = sorted.filter(d => d <= new Date().toISOString().slice(0, 10));
  const future = sorted.filter(d => d >  new Date().toISOString().slice(0, 10));

  // Any already-announced future date is ground truth
  if (future.length) return { confirmed: sorted, predicted: future[0] };

  if (past.length < 2) {
    // Single data point: common intervals are 90d (Q), 180d (H), 365d (A)
    // Default to 6 months if only one date
    const d = new Date(past[past.length - 1]);
    d.setDate(d.getDate() + 180);
    return { confirmed: past, predicted: d.toISOString().slice(0, 10) };
  }

  // Calculate average interval between consecutive reports
  const diffs = [];
  for (let i = 1; i < past.length; i++) {
    diffs.push((new Date(past[i]) - new Date(past[i - 1])) / 86400000);
  }
  const avg = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);

  // Snap to nearest standard interval: 90 (Q), 120 (Q-ish), 180 (H), 365 (A)
  const snapIntervals = [90, 120, 180, 365];
  const snapped = snapIntervals.reduce((a, b) => Math.abs(a - avg) < Math.abs(b - avg) ? a : b);

  // Predict from last known date
  const last = new Date(past[past.length - 1]);
  last.setDate(last.getDate() + snapped);
  const predicted = last.toISOString().slice(0, 10);

  return { confirmed: past, predicted, avgInterval: avg };
}

// ── Finnhub: for non-NO markets ───────────────────────────────────────────

function bareTicker(ticker) {
  return ticker.replace(/\.(AS|PA|DE|MI|OL|ST|CO|HE|BR|SW|VI|LS|MC|L|WA|IR|LU|PR|SI|HK|T|KS|AX|JO|TO|V|F)$/i, '');
}

async function fetchFinnhub(ticker, countryCode, yahooOverride) {
  if (!FINNHUB_KEY) return null;
  const today = new Date().toISOString().slice(0, 10);
  const to    = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const expectedSuffix = (PRIMARY_SUFFIX[countryCode] || '').toUpperCase();

  const candidates = new Set();
  if (yahooOverride) { candidates.add(bareTicker(yahooOverride)); candidates.add(yahooOverride); }
  candidates.add(bareTicker(ticker));
  if (ticker !== bareTicker(ticker)) candidates.add(ticker);

  for (const sym of candidates) {
    const json = await getJson(
      `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${to}&symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`
    );
    if (!json?.earningsCalendar?.length) { await sleep(DELAY_MS); continue; }

    const resolved = json.earningsCalendar[0]?.symbol || sym;
    if (expectedSuffix) {
      const resSuffix = (resolved.match(/\.[A-Z]{1,3}$/)?.[0] || '').toUpperCase();
      if (!resSuffix || resSuffix !== expectedSuffix) { await sleep(DELAY_MS); continue; }
    }

    const dates = json.earningsCalendar.map(e => e.date).filter(Boolean).sort();
    return { dates, resolvedSymbol: resolved };
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('📅  Earnings Calendar Fetcher');

  // Verify table exists
  const { error: tableErr } = await supabase.from('earnings_calendar').select('ticker').limit(1);
  if (tableErr) {
    console.error('\n❌  earnings_calendar table not found.');
    console.error('   Run migrations/005_earnings_calendar.sql in Supabase dashboard.\n');
    process.exit(1);
  }

  // Load all tickers from DB
  const { data: txRows } = await supabase
    .from('insider_transactions').select('ticker,country_code')
    .not('ticker', 'is', null).neq('ticker', '');
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

  const noTickers = new Set(tickers.filter(([,cc]) => cc === 'NO').map(([t]) => t));
  const otherTickers = tickers.filter(([,cc]) => cc !== 'NO');
  console.log(`  NO (Oslo Bors): ${noTickers.size} tickers`);
  console.log(`  Other markets (Finnhub${FINNHUB_KEY ? '' : ' — key not set, skip'}): ${otherTickers.length} tickers\n`);

  const t0 = Date.now();
  const rows = [];
  let totalFound = 0, totalUpserted = 0;

  // ── NORWAY: Oslo Bors approach ──────────────────────────────────────────
  if (noTickers.size > 0) {
    console.log('── Norway: fetching Oslo Bors report history…');
    const osloData = await fetchOsloBorsReportDates();
    console.log(`  Oslo Bors: ${osloData.size} tickers with filing history`);

    let noFound = 0, noPredicted = 0;
    for (const ticker of noTickers) {
      const dateSet = osloData.get(ticker);
      if (!dateSet || dateSet.size === 0) continue;

      const { confirmed, predicted, avgInterval } = predictNextDate(dateSet);
      noFound++;

      // Store all confirmed past dates
      for (const d of confirmed) rows.push({ ticker, country_code: 'NO', earnings_date: d, source: 'oslo_bors' });

      // Store predicted next date (mark as predicted)
      if (predicted && predicted > new Date().toISOString().slice(0, 10)) {
        rows.push({ ticker, country_code: 'NO', earnings_date: predicted, source: 'oslo_bors_predicted' });
        noPredicted++;
      }
    }

    console.log(`  ✅ NO: ${noFound}/${noTickers.size} tickers matched, ${noPredicted} future dates predicted`);
    totalFound += noFound;

    // Flush Norway rows
    if (rows.length > 0) {
      const { error } = await supabase.from('earnings_calendar')
        .upsert(rows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠  upsert error:', error.message);
      else { totalUpserted += rows.length; console.log(`  Upserted ${rows.length} NO date rows`); }
      rows.length = 0;
    }
  }

  // ── OTHER MARKETS: Finnhub ─────────────────────────────────────────────
  if (FINNHUB_KEY && otherTickers.length > 0) {
    console.log('\n── Other markets: Finnhub…');
    let finnhubFound = 0;
    const finnhubRows = [];

    for (let i = 0; i < otherTickers.length; i++) {
      const [ticker, countryCode] = otherTickers[i];
      const result = await fetchFinnhub(ticker, countryCode, overrides.get(ticker) || null);
      if (result) {
        finnhubFound++;
        for (const d of result.dates) {
          finnhubRows.push({ ticker, country_code: countryCode, earnings_date: d, source: 'finnhub' });
        }
        if (i < 5 || (i + 1) % 100 === 0)
          console.log(`  ✓ ${ticker} → ${result.resolvedSymbol}: ${result.dates.join(', ')}`);
      }
      if ((i + 1) % 60 === 0) {
        console.log(`  [${i + 1}/${otherTickers.length}] Finnhub found: ${finnhubFound}`);
        await sleep(1500);
      } else {
        await sleep(DELAY_MS);
      }
    }

    if (finnhubRows.length > 0) {
      const { error } = await supabase.from('earnings_calendar')
        .upsert(finnhubRows, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠  upsert error:', error.message);
      else totalUpserted += finnhubRows.length;
    }
    console.log(`  ✅ Finnhub: ${finnhubFound}/${otherTickers.length} tickers (${Math.round(finnhubFound / otherTickers.length * 100)}%)`);
    totalFound += finnhubFound;
  } else if (!FINNHUB_KEY) {
    console.log('\n── Other markets: skipped (set FINNHUB_API_KEY to enable Finnhub)');
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ✅  Done in ${secs}s — ${totalFound} tickers covered`);
  console.log(`  Total dates upserted: ${totalUpserted}`);
  console.log(`  Norway:       Oslo Bors (categories 1001+1002) — ~100% coverage`);
  console.log(`  Other mkts:   Finnhub free tier — ~1-5% (cross-listed only)`);
  console.log(`═══════════════════════════════════════════════════════\n`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
