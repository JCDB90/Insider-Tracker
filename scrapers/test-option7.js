'use strict';
/**
 * Option 7: Pattern detection from our own transaction data
 * + StockAnalysis scrape for US-dual-listed European companies
 */
const https = require('https');
const { supabase } = require('./lib/db');

function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, h: res.headers }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message, h: {} }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', h: {} }); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── StockAnalysis.com scraper ─────────────────────────────────────────────

function extractSADates(html) {
  // StockAnalysis embeds data in a svelte store or script tag
  // Look for the next earnings date specifically
  const patterns = [
    // "Next Earnings Date: Apr 15, 2026" or similar
    /(?:next\s+earnings|earnings\s+date|upcoming\s+earnings)[^\n<]{0,100}/gi,
    // Date in ISO format near "earnings"
    /(?:earningDate|nextEarningsDate|earnings_date)['":\s]+['"]?(\d{4}-\d{2}-\d{2})/gi,
    // JSON embedded data
    /"date"\s*:\s*"(202[5-7]-\d{2}-\d{2})"/g,
    // ISO dates anywhere
    /202[5-7]-\d{2}-\d{2}/g,
    // Month Day Year
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+202[5-7]/g,
  ];
  const results = new Set();
  for (const p of patterns) {
    for (const m of html.matchAll(p)) {
      const match = m[1] || m[0];
      if (/202[5-7]/.test(match)) results.add(match.trim());
    }
  }
  return [...results];
}

async function scrapeStockAnalysis(symbol) {
  // Try multiple URL patterns
  const urls = [
    `https://stockanalysis.com/stocks/${symbol.toLowerCase()}/financials/`,
    `https://stockanalysis.com/stocks/${symbol.toLowerCase()}/`,
  ];
  for (const url of urls) {
    const r = await get(url);
    if (r.s !== 200) { await sleep(400); continue; }
    const dates = extractSADates(r.b);
    // Find "next earnings" context specifically
    const ctx = [...r.b.matchAll(/(?:next\s+earnings|earnings\s+date|Q\d\s+202[5-7]\s+earnings)[^<]{0,100}/gi)]
      .map(m => m[0].replace(/\s+/g, ' ').trim()).slice(0, 3);
    // Also look for the date in the page header/metadata
    const metaDates = [...r.b.matchAll(/<meta[^>]+(?:earnings|report)[^>]*content="([^"]+)"/gi)]
      .map(m => m[1]);
    return { found: true, dates, ctx, metaDates, url };
  }
  return { found: false, dates: [] };
}

// ── Option 7: Transaction cluster pattern detector ────────────────────────

/**
 * Detect earnings dates from insider transaction burst patterns.
 *
 * Theory: When a blackout period ends (right after earnings), insiders
 * often file several transactions within a short window (2-14 days).
 * These "burst clusters" mark the end of blackout periods = earnings dates.
 *
 * Also handles single-transaction companies by using filing date as
 * a proxy with the company's typical reporting interval.
 */
function detectEarningsFromClusters(transactions) {
  if (!transactions.length) return null;

  // Sort by date
  const dates = transactions.map(t => t.transaction_date).sort();

  // Find clusters: groups of dates within a 14-day window
  const clusters = [];
  let cluster = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(cluster[cluster.length - 1]);
    const curr = new Date(dates[i]);
    if ((curr - prev) / 86400000 <= 14) {
      cluster.push(dates[i]);
    } else {
      clusters.push(cluster);
      cluster = [dates[i]];
    }
  }
  clusters.push(cluster);

  // Cluster date = first date in cluster (closest to when blackout lifted)
  const clusterDates = clusters.map(c => c[0]).sort();

  if (clusterDates.length < 2) {
    // Only one data point — can't calculate interval
    return { clusterDates, predictedNext: null, confidence: 'low', reason: 'single cluster' };
  }

  // Calculate intervals between clusters
  const intervals = [];
  for (let i = 1; i < clusterDates.length; i++) {
    const diff = (new Date(clusterDates[i]) - new Date(clusterDates[i - 1])) / 86400000;
    intervals.push(diff);
  }
  const avgInterval = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);

  // Snap to nearest standard reporting cadence
  const snapTo = [90, 120, 182, 365];
  const snapped = snapTo.reduce((a, b) => Math.abs(a - avgInterval) < Math.abs(b - avgInterval) ? a : b);
  const cadence = snapped <= 95 ? 'quarterly' : snapped <= 200 ? 'semi-annual' : 'annual';

  // Earnings date ≈ cluster date (transactions start within 0-7 days after blackout ends)
  // Blackout typically starts 30 days before → earnings ≈ clusterDate
  const lastCluster = new Date(clusterDates[clusterDates.length - 1]);
  const predicted = new Date(lastCluster);
  predicted.setDate(predicted.getDate() + snapped);
  const predictedNext = predicted.toISOString().slice(0, 10);

  return {
    clusterDates,
    clusters: clusters.length,
    avgInterval,
    snappedInterval: snapped,
    cadence,
    predictedNext,
    confidence: clusters.length >= 3 ? 'high' : 'medium',
  };
}

async function main() {
  console.log('=== Option 7: Pattern Detector ===\n');

  // Load transactions grouped by company+ticker
  const { data: allTx } = await supabase
    .from('insider_transactions')
    .select('ticker,company,country_code,transaction_date,transaction_type')
    .eq('transaction_type', 'BUY')  // only buys — more meaningful post-blackout signal
    .not('ticker', 'is', null)
    .order('transaction_date', { ascending: true });

  // Group by ticker
  const byTicker = {};
  for (const t of allTx || []) {
    const key = `${t.ticker}:${t.country_code}`;
    if (!byTicker[key]) byTicker[key] = { ticker: t.ticker, company: t.company, cc: t.country_code, txns: [] };
    byTicker[key].txns.push(t);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Process each company
  const results = [];
  for (const [key, data] of Object.entries(byTicker)) {
    if (data.txns.length < 2) continue; // Need at least 2 transactions
    const analysis = detectEarningsFromClusters(data.txns);
    if (!analysis || !analysis.predictedNext) continue;
    if (analysis.predictedNext <= today) continue; // Only future dates
    results.push({ ...data, ...analysis });
  }

  // Sort by confidence then cadence consistency
  results.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.predictedNext.localeCompare(b.predictedNext);
  });

  console.log(`Found ${results.length} companies with future earnings predictions\n`);

  // Show watchlist companies first
  const watchlist = ['ASML','VID','THEP','PRX','FLOW','JEN','INDU-C'];
  console.log('=== Watchlist companies ===');
  for (const ticker of watchlist) {
    const r = results.find(x => x.ticker === ticker);
    const raw = byTicker[Object.keys(byTicker).find(k => k.startsWith(ticker + ':')) || ''];
    if (r) {
      console.log(`  ${ticker.padEnd(10)} [${r.cc}] ${r.company?.slice(0,25)?.padEnd(25)} clusters=${r.clusters} cadence=${r.cadence} (${r.snappedInterval}d avg=${r.avgInterval}d)`);
      console.log(`           cluster dates: ${r.clusterDates.join(', ')}`);
      console.log(`           → predicted next: ${r.predictedNext} [${r.confidence} confidence]`);
    } else if (raw) {
      console.log(`  ${ticker.padEnd(10)} [${raw.cc}] ${raw.txns.length} transaction(s) — not enough for pattern`);
      console.log(`           tx dates: ${raw.txns.map(t=>t.transaction_date).join(', ')}`);
    } else {
      console.log(`  ${ticker.padEnd(10)} — not in DB`);
    }
  }

  console.log(`\n=== All companies by country (high confidence first) ===`);
  const byCC = {};
  for (const r of results) {
    if (!byCC[r.cc]) byCC[r.cc] = [];
    byCC[r.cc].push(r);
  }
  for (const [cc, items] of Object.entries(byCC).sort()) {
    console.log(`\n  [${cc}] ${items.length} companies:`);
    items.slice(0, 8).forEach(r =>
      console.log(`    ${r.ticker.padEnd(12)} ${r.cadence.padEnd(12)} next=${r.predictedNext} [${r.confidence}] clusters=${r.clusters}`)
    );
    if (items.length > 8) console.log(`    ... and ${items.length - 8} more`);
  }

  // Coverage summary
  const { data: allTickers } = await supabase
    .from('insider_transactions').select('ticker,country_code').not('ticker','is',null).neq('ticker','');
  const uniqueTickers = new Set((allTickers||[]).map(r => r.ticker+':'+r.country_code));
  console.log(`\n=== Coverage Summary ===`);
  console.log(`  DB tickers total:       ${uniqueTickers.size}`);
  console.log(`  Pattern-predicted:      ${results.length} (${Math.round(results.length/uniqueTickers.size*100)}%)`);
  console.log(`  High confidence:        ${results.filter(r=>r.confidence==='high').length}`);
  console.log(`  Medium confidence:      ${results.filter(r=>r.confidence==='medium').length}`);

  // ── StockAnalysis for US-dual-listed companies ─────────────────────────
  console.log('\n=== StockAnalysis for US-listed European companies ===');
  const usDualListed = [
    { ticker: 'ASML', saSymbol: 'asml',  cc: 'NL', company: 'ASML Holding' },
    { ticker: 'SAP',  saSymbol: 'sap',   cc: 'DE', company: 'SAP SE'       },
    { ticker: 'NVO',  saSymbol: 'nvo',   cc: 'DK', company: 'Novo Nordisk' },
    { ticker: 'EQNR', saSymbol: 'eqnr',  cc: 'NO', company: 'Equinor'      },
  ];
  for (const { ticker, saSymbol, cc, company } of usDualListed) {
    const r = await scrapeStockAnalysis(saSymbol);
    if (r.found) {
      // Try to find the next earnings date specifically
      const nextEarnings = r.b ? r.b.match(/(?:Next Earnings|Earnings Date)[:\s]+([A-Z][a-z]+ \d+, 202[5-7]|\d{4}-\d{2}-\d{2})/i) : null;
      console.log(`  ${ticker.padEnd(8)} [${cc}] ${company}: found=${r.found} dates=${r.dates.slice(0,5).join(' | ')||'none'}`);
      if (nextEarnings) console.log(`    NEXT EARNINGS: ${nextEarnings[1]}`);
      if (r.ctx.length) r.ctx.forEach(c => console.log(`    ctx: ${c.slice(0,100)}`));
    } else {
      console.log(`  ${ticker.padEnd(8)} [${cc}] ${company}: not found on StockAnalysis`);
    }
    await sleep(600);
  }

  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
