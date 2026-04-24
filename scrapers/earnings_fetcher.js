'use strict';
/**
 * Earnings Calendar Fetcher — multi-source, market-aware
 *
 * Source 1: Oslo Bors newsreader (NO only, free)
 *   Categories 1001 (Annual) + 1002 (Interim) → real filing dates + cadence prediction
 *   Coverage: ~100% of Norwegian tickers
 *
 * Source 2: StockAnalysis.com scraping (US-dual-listed EU companies)
 *   Scrapes "Earnings Date XXX" from stockanalysis.com/stocks/{symbol}/
 *   Covers: ASML, SAP, EQNR, NVO, RACE, UL, SHELL, AZN, NVS, etc.
 *   Coverage: ~10-20% of our DB (companies with NASDAQ/NYSE listings)
 *
 * Source 3: Transaction burst detection (all EU markets)
 *   Finds clusters of insider transactions (≥2 in 14 days = post-blackout burst)
 *   Predicts next earnings: burst_date + cadence interval
 *   Default cadence: semi-annual (182d) for EU mid/small-caps
 *   Coverage: ~30-40% of companies with 2+ transactions in DB
 *
 * Source 4: Finnhub free tier (minimal EU cross-listed)
 *   Requires FINNHUB_API_KEY, covers <5% additional
 *
 * Usage:
 *   node scrapers/earnings_fetcher.js
 *   FINNHUB_API_KEY=xxx node scrapers/earnings_fetcher.js
 */

const https   = require('https');
const { supabase } = require('./lib/db');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const OSLO_BASE   = 'https://api3.oslo.oslobors.no';
const OSLO_ORIGIN = 'https://newsweb.oslobors.no';

// Per-company request delay (ms) — respects robots/rate limits
const DELAY_SA      = 600;   // StockAnalysis
const DELAY_FINNHUB = 220;

// Primary exchange suffix for Finnhub validation
const PRIMARY_SUFFIX = {
  NL:'.AS', FR:'.PA', DE:'.DE', GB:'.L',  SE:'.ST', DK:'.CO', FI:'.HE',
  NO:'.OL', BE:'.BR', PT:'.LS', IT:'.MI', ES:'.MC', AT:'.VI', CH:'.SW',
  PL:'.WA', IE:'.IR', LU:'.LU', CZ:'.PR', SG:'.SI', HK:'.HK', JP:'.T',
  KR:'.KS', AU:'.AX', ZA:'.JO', CA:'.TO',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getHttp(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Accept': 'text/html,application/json,*/*', ...headers },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, h: res.headers }));
    });
    req.on('error', () => resolve({ s: 0, b: '', h: {} }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', h: {} }); });
  });
}
function getJson(url, headers = {}) {
  return getHttp(url, { ...headers, 'Accept': 'application/json' }).then(r => {
    if (r.s !== 200) return null;
    try { return JSON.parse(r.b); } catch { return null; }
  });
}

// ── Source 1: Oslo Bors ────────────────────────────────────────────────────

async function fetchOsloBorsReportDates() {
  const past2y = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const in12m  = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const today  = new Date().toISOString().slice(0, 10);
  const tickerDates = new Map();

  for (const cat of [1001, 1002]) {
    for (const range of [
      { from: past2y, to: today },
      { from: today,  to: in12m },
    ]) {
      const json = await getJson(
        `${OSLO_BASE}/v1/newsreader/list?category=${cat}&fromDate=${range.from}&toDate=${range.to}`,
        { 'Origin': OSLO_ORIGIN, 'Referer': OSLO_ORIGIN + '/' }
      );
      for (const m of (json?.data?.messages || [])) {
        const ticker = m.issuerSign?.trim();
        const date   = (m.publishedTime || '').slice(0, 10);
        if (!ticker || !date) continue;
        if (!tickerDates.has(ticker)) tickerDates.set(ticker, new Set());
        tickerDates.get(ticker).add(date);
      }
      await sleep(300);
    }
  }
  return tickerDates;
}

function predictNextFromDates(dates) {
  const sorted = [...dates].sort();
  const today  = new Date().toISOString().slice(0, 10);
  const future = sorted.filter(d => d > today);
  if (future.length) return { confirmed: sorted, predicted: future[0] };
  if (sorted.length < 2) {
    const d = new Date(sorted[0]); d.setDate(d.getDate() + 180);
    return { confirmed: sorted, predicted: d.toISOString().slice(0, 10) };
  }
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) diffs.push((new Date(sorted[i]) - new Date(sorted[i-1])) / 86400000);
  const avg = Math.round(diffs.reduce((a,b) => a+b,0) / diffs.length);
  const snap = [90,120,180,365].reduce((a,b) => Math.abs(a-avg) < Math.abs(b-avg) ? a : b);
  const next = new Date(sorted[sorted.length-1]); next.setDate(next.getDate() + snap);
  return { confirmed: sorted, predicted: next.toISOString().slice(0, 10), avgInterval: avg };
}

// ── Source 2: StockAnalysis.com ────────────────────────────────────────────

// Parse the earnings date from StockAnalysis HTML
function parseStockAnalysisDate(html) {
  // "Earnings Date" appears immediately followed by the date (no separator)
  const m = html.match(/Earnings Date\s*([A-Z][a-z]{2}\s+\d{1,2},?\s+202[5-7]|\d{4}-\d{2}-\d{2})/);
  if (m) return normaliseDate(m[1]);
  // Also try the quarterly financials page — "Apr 15, 2026" near report context
  const dates = [];
  for (const match of html.matchAll(/(?:Apr|Jan|Feb|Mar|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+202[5-7]/g)) {
    dates.push(normaliseDate(match[0]));
  }
  // Return the earliest future date
  const today = new Date().toISOString().slice(0, 10);
  const future = dates.filter(d => d > today).sort();
  return future[0] || null;
}

function normaliseDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  try {
    const d = new Date(raw.replace(',', ''));
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

async function fetchStockAnalysis(ticker) {
  // Try bare ticker (works for NASDAQ/NYSE listed stocks)
  const sym = ticker.replace(/\.(AS|PA|DE|MI|OL|ST|CO|HE|BR|SW|VI|LS|MC|L|WA|IR|LU|PR|SI|HK|T|KS|AX|JO|TO)$/i, '').toLowerCase();
  const r = await getHttp(`https://stockanalysis.com/stocks/${sym}/`);
  if (r.s !== 200) return null;
  const date = parseStockAnalysisDate(r.b);
  if (date) return { date, symbol: sym, source: 'stockanalysis' };
  // Also try quarterly financials page for more date context
  await sleep(400);
  const r2 = await getHttp(`https://stockanalysis.com/stocks/${sym}/financials/?p=quarterly`);
  if (r2.s === 200) {
    const d2 = parseStockAnalysisDate(r2.b);
    if (d2) return { date: d2, symbol: sym, source: 'stockanalysis' };
  }
  return null;
}

// ── Source 3: Transaction burst detection ─────────────────────────────────

/**
 * Detect post-blackout bursts from insider transaction history.
 * A burst = ≥2 transactions within a 14-day window.
 * Bursts mark the end of blackout periods ≈ earnings announcement dates.
 */
function detectBursts(transactions) {
  // Normalise dates to YYYY-MM-DD (in case DB returns full timestamps)
  const dates = [...new Set(transactions.map(t => String(t.transaction_date).slice(0, 10)))].filter(Boolean).sort();
  if (dates.length < 2) return null;

  // Find burst clusters: consecutive dates within 14 days of each other
  const clusters = [];
  let cluster = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    const gap = (new Date(dates[i]) - new Date(cluster[0])) / 86400000;
    if (gap <= 14) {
      cluster.push(dates[i]);
    } else {
      if (cluster.length >= 2) clusters.push(cluster[cluster.length - 1]); // last date in burst
      cluster = [dates[i]];
    }
  }
  if (cluster.length >= 2) clusters.push(cluster[cluster.length - 1]);

  if (clusters.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);

  // Calculate interval from cluster dates
  let interval = 182; // default semi-annual (most EU mid-caps)
  if (clusters.length >= 2) {
    const diffs = [];
    for (let i = 1; i < clusters.length; i++) diffs.push((new Date(clusters[i]) - new Date(clusters[i-1])) / 86400000);
    const avg = diffs.reduce((a,b) => a+b,0) / diffs.length;
    if (avg < 30) {
      // Sub-bursts from the same reporting window (e.g. 10 insiders filing over 3 weeks).
      // The interval between them is NOT a reporting period — default to semi-annual.
      interval = 182;
    } else {
      interval = [90, 120, 182, 365].reduce((a,b) => Math.abs(a-avg) < Math.abs(b-avg) ? a : b);
    }
  }

  // Predict next: last burst + interval
  const lastBurst = new Date(clusters[clusters.length - 1]);
  lastBurst.setDate(lastBurst.getDate() + interval);
  const predicted = lastBurst.toISOString().slice(0, 10);

  if (predicted <= today) return null; // Past prediction, skip
  const cadence = interval <= 95 ? 'quarterly' : interval <= 200 ? 'semi-annual' : 'annual';
  const confidence = clusters.length >= 2 ? 'medium' : 'low';
  return { burstDates: clusters, predicted, interval, cadence, confidence };
}

// ── Source 4: Finnhub ──────────────────────────────────────────────────────

function bareTicker(t) {
  return t.replace(/\.(AS|PA|DE|MI|OL|ST|CO|HE|BR|SW|VI|LS|MC|L|WA|IR|LU|PR|SI|HK|T|KS|AX|JO|TO|V|F)$/i, '');
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
    const json = await getJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${to}&symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`);
    if (!json?.earningsCalendar?.length) { await sleep(DELAY_FINNHUB); continue; }
    const resolved = json.earningsCalendar[0]?.symbol || sym;
    if (expectedSuffix) {
      const resSuffix = (resolved.match(/\.[A-Z]{1,3}$/)?.[0] || '').toUpperCase();
      if (!resSuffix || resSuffix !== expectedSuffix) { await sleep(DELAY_FINNHUB); continue; }
    }
    const dates = json.earningsCalendar.map(e => e.date).filter(Boolean).sort();
    return { dates, resolvedSymbol: resolved };
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📅  Earnings Calendar Fetcher — multi-source');

  const { error: tableErr } = await supabase.from('earnings_calendar').select('ticker').limit(1);
  if (tableErr) {
    console.error('\n❌  earnings_calendar table not found.');
    console.error('   Run migrations/005_earnings_calendar.sql in Supabase dashboard.\n');
    process.exit(1);
  }

  // Load all tickers and their transactions
  const { data: txRows } = await supabase
    .from('insider_transactions')
    .select('ticker,company,country_code,transaction_date,transaction_type')
    .not('ticker', 'is', null).neq('ticker', '')
    .order('transaction_date', { ascending: true });

  const tickerMap = new Map();  // ticker:cc → { ticker, company, cc, txns }
  for (const r of txRows || []) {
    const key = `${r.ticker}:${r.country_code}`;
    if (!tickerMap.has(key)) tickerMap.set(key, { ticker: r.ticker, company: r.company, cc: r.country_code, txns: [] });
    tickerMap.get(key).txns.push(r);
  }

  // Unique tickers by country
  const byCC = {};
  for (const v of tickerMap.values()) {
    if (!byCC[v.cc]) byCC[v.cc] = [];
    byCC[v.cc].push(v);
  }

  const { data: wl } = await supabase.from('watchlist').select('ticker,country_code,yahoo_ticker');
  const overrides = new Map();
  for (const w of wl || []) if (w.yahoo_ticker) overrides.set(w.ticker, w.yahoo_ticker);

  const t0 = Date.now();
  const allRows = [];
  const sources = { oslo_bors: 0, stockanalysis: 0, burst: 0, finnhub: 0 };

  // ── Source 1: Norway via Oslo Bors ──────────────────────────────────────
  const noEntries = byCC['NO'] || [];
  if (noEntries.length > 0) {
    console.log(`\n── Source 1: Oslo Bors (${noEntries.length} NO tickers)…`);
    const osloData = await fetchOsloBorsReportDates();
    let found = 0;
    for (const { ticker } of noEntries) {
      const dateSet = osloData.get(ticker);
      if (!dateSet?.size) continue;
      found++;
      const { confirmed, predicted } = predictNextFromDates(dateSet);
      for (const d of confirmed) allRows.push({ ticker, country_code: 'NO', earnings_date: d, source: 'oslo_bors' });
      const today = new Date().toISOString().slice(0, 10);
      if (predicted > today) allRows.push({ ticker, country_code: 'NO', earnings_date: predicted, source: 'oslo_bors_predicted' });
    }
    sources.oslo_bors = found;
    console.log(`  ✅ ${found}/${noEntries.length} NO tickers matched`);
  }

  // ── Source 2: StockAnalysis (US-dual-listed) ────────────────────────────
  const nonNO = Object.entries(byCC).filter(([cc]) => cc !== 'NO').flatMap(([,v]) => v);
  console.log(`\n── Source 2: StockAnalysis (${nonNO.length} non-NO tickers, rate-limited 600ms each)…`);

  let saFound = 0, saTried = 0;
  for (const { ticker, cc } of nonNO) {
    saTried++;
    const result = await fetchStockAnalysis(ticker);
    if (result?.date) {
      saFound++;
      sources.stockanalysis++;
      allRows.push({ ticker, country_code: cc, earnings_date: result.date, source: 'stockanalysis' });
      console.log(`  ✅ [SA] ${ticker.padEnd(10)} [${cc}] → ${result.date}`);
    }
    if (saTried % 20 === 0) console.log(`  [SA] ${saTried}/${nonNO.length} tried, ${saFound} found`);
    await sleep(DELAY_SA);
  }
  console.log(`  ✅ StockAnalysis: ${saFound}/${nonNO.length} tickers (${Math.round(saFound/nonNO.length*100)}%)`);

  // ── Source 3: Transaction burst detection ──────────────────────────────
  console.log(`\n── Source 3: Transaction burst detection…`);
  let burstFound = 0;
  const today = new Date().toISOString().slice(0, 10);
  // Already covered by previous sources
  const coveredTickers = new Set(allRows.map(r => `${r.ticker}:${r.country_code}`));

  for (const [key, { ticker, cc, txns }] of tickerMap) {
    if (cc === 'NO') continue; // Already handled
    if (coveredTickers.has(key)) continue; // Already found by SA/Finnhub
    const burst = detectBursts(txns);
    if (!burst || burst.predicted <= today) continue;
    burstFound++;
    sources.burst++;
    allRows.push({ ticker, country_code: cc, earnings_date: burst.predicted, source: `burst_${burst.cadence}` });
  }
  console.log(`  ✅ Burst detection: ${burstFound} new predictions`);

  // ── Source 4: Finnhub (optional) ───────────────────────────────────────
  if (FINNHUB_KEY) {
    console.log(`\n── Source 4: Finnhub (${nonNO.length} non-NO tickers)…`);
    let fhFound = 0;
    const coveredNow = new Set(allRows.map(r => `${r.ticker}:${r.country_code}`));
    for (const { ticker, cc } of nonNO) {
      if (coveredNow.has(`${ticker}:${cc}`)) { await sleep(50); continue; }
      const result = await fetchFinnhub(ticker, cc, overrides.get(ticker) || null);
      if (result) {
        fhFound++; sources.finnhub++;
        for (const d of result.dates) allRows.push({ ticker, country_code: cc, earnings_date: d, source: 'finnhub' });
      }
      await sleep(DELAY_FINNHUB);
    }
    console.log(`  ✅ Finnhub: ${fhFound} tickers`);
  }

  // ── Flush to Supabase ──────────────────────────────────────────────────
  let upserted = 0;
  if (allRows.length > 0) {
    // Batch upsert in chunks of 100
    for (let i = 0; i < allRows.length; i += 100) {
      const chunk = allRows.slice(i, i + 100);
      const { error } = await supabase.from('earnings_calendar')
        .upsert(chunk, { onConflict: 'ticker,earnings_date', ignoreDuplicates: false });
      if (error) console.error('  ⚠  upsert error:', error.message);
      else upserted += chunk.length;
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalTickers = tickerMap.size;
  const coveredFinal = new Set(allRows.map(r => r.ticker + ':' + r.country_code)).size;
  const futureDates = allRows.filter(r => r.earnings_date > today);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  Done in ${secs}s`);
  console.log(`  Tickers covered: ${coveredFinal}/${totalTickers} (${Math.round(coveredFinal/totalTickers*100)}%)`);
  console.log(`  Earnings dates upserted: ${upserted}`);
  console.log(`  Future dates stored: ${futureDates.length}`);
  console.log(`  Sources: Oslo Bors=${sources.oslo_bors} StockAnalysis=${sources.stockanalysis} Burst=${sources.burst} Finnhub=${sources.finnhub}`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
