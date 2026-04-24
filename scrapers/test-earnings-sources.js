'use strict';
const https = require('https');

const TICKERS = [
  { yahoo: 'ASML.AS',    fmp: 'ASML.AS',     av: 'ASML',    finnhub: 'ASML.AS',    label: 'ASML (NL)'            },
  { yahoo: 'VID.MC',     fmp: 'VID.MC',      av: 'VID',     finnhub: 'VID.MC',     label: 'Vidrala (ES)'         },
  { yahoo: 'INDU-C.ST',  fmp: 'INDU-C.ST',   av: 'INDU-C',  finnhub: 'INDU-C.ST',  label: 'Industrivärden (SE)'  },
  { yahoo: 'MC.PA',      fmp: 'MC.PA',        av: 'MC',      finnhub: 'MC.PA',      label: 'LVMH (FR)'            },
  { yahoo: 'SAP.DE',     fmp: 'SAP.DE',       av: 'SAP',     finnhub: 'SAP.DE',     label: 'SAP (DE)'             },
  { yahoo: 'ENI.MI',     fmp: 'ENI.MI',       av: 'ENI',     finnhub: 'ENI.MI',     label: 'ENI (IT)'             },
  { yahoo: 'EQNR.OL',    fmp: 'EQNR.OL',      av: 'EQNR',    finnhub: 'EQNR.OL',    label: 'Equinor (NO)'         },
  { yahoo: 'NDA-SE.ST',  fmp: 'NDA-SE.ST',    av: 'NDA-SE',  finnhub: 'NDA-SE.ST',  label: 'Nordea (SE)'          },
];

function get(url, extraHeaders = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...extraHeaders,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Yahoo Finance ─────────────────────────────────────────────────────────

async function testYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents`;
  const { status, body } = await get(url);
  if (status !== 200) return { source: 'yahoo', ticker, found: false, error: `HTTP ${status}` };
  try {
    const json  = JSON.parse(body);
    const result = json?.quoteSummary?.result?.[0];
    const cal   = result?.calendarEvents;
    if (!cal) return { source: 'yahoo', ticker, found: false, error: 'no calendarEvents' };
    const earningsArr = cal.earnings?.earningsDate || [];
    const dates = earningsArr
      .map(e => e?.raw ?? e)
      .filter(ts => ts && typeof ts === 'number')
      .map(ts => new Date(ts * 1000).toISOString().slice(0, 10))
      .sort();
    return { source: 'yahoo', ticker, found: dates.length > 0, dates };
  } catch (e) { return { source: 'yahoo', ticker, found: false, error: 'parse: ' + e.message }; }
}

// ─── Financial Modeling Prep ───────────────────────────────────────────────

async function testFMP(ticker) {
  const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${encodeURIComponent(ticker)}?limit=5&apikey=demo`;
  const { status, body } = await get(url);
  if (status !== 200) return { source: 'fmp', ticker, found: false, error: `HTTP ${status}` };
  try {
    const json = JSON.parse(body);
    if (!Array.isArray(json) || json.length === 0) {
      // Check for error message
      const msg = json?.['Error Message'] || json?.message || 'empty array';
      return { source: 'fmp', ticker, found: false, error: String(msg).slice(0, 80) };
    }
    const dates = json.map(r => r.date).filter(Boolean).sort().reverse().slice(0, 5);
    return { source: 'fmp', ticker, found: dates.length > 0, dates, rawSample: json[0] };
  } catch (e) { return { source: 'fmp', ticker, found: false, error: 'parse: ' + e.message }; }
}

// Also try FMP /earning_calendar (undated range endpoint)
async function testFMPRange(ticker) {
  const from = '2025-01-01';
  const to   = '2027-01-01';
  const url  = `https://financialmodelingprep.com/api/v3/earning_calendar?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&apikey=demo`;
  const { status, body } = await get(url);
  if (status !== 200) return { source: 'fmp-range', ticker, found: false, error: `HTTP ${status}` };
  try {
    const json = JSON.parse(body);
    if (!Array.isArray(json) || json.length === 0) {
      const msg = json?.['Error Message'] || json?.message || 'empty';
      return { source: 'fmp-range', ticker, found: false, error: String(msg).slice(0, 80) };
    }
    const dates = json.map(r => r.date).filter(Boolean).sort();
    return { source: 'fmp-range', ticker, found: dates.length > 0, dates: dates.slice(0, 5) };
  } catch (e) { return { source: 'fmp-range', ticker, found: false, error: 'parse: ' + e.message }; }
}

// ─── Alpha Vantage ─────────────────────────────────────────────────────────

async function testAlphaVantage(ticker) {
  const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}&apikey=demo`;
  const { status, body } = await get(url);
  if (status !== 200) return { source: 'alphavantage', ticker, found: false, error: `HTTP ${status}` };
  try {
    const json = JSON.parse(body);
    if (json?.Information) return { source: 'alphavantage', ticker, found: false, error: 'rate-limited: ' + json.Information.slice(0, 60) };
    if (json?.Note)        return { source: 'alphavantage', ticker, found: false, error: 'rate-limited' };
    const quarterly = json?.quarterlyEarnings || [];
    const dates = quarterly.map(r => r.reportedDate || r.fiscalDateEnding).filter(Boolean).sort().reverse().slice(0, 4);
    return { source: 'alphavantage', ticker, found: dates.length > 0, dates };
  } catch (e) { return { source: 'alphavantage', ticker, found: false, error: 'parse: ' + e.message }; }
}

// ─── Finnhub ───────────────────────────────────────────────────────────────

async function testFinnhub(ticker) {
  const from = '2025-01-01';
  const to   = '2027-01-01';
  const url  = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=demo`;
  const { status, body } = await get(url);
  if (status !== 200) return { source: 'finnhub', ticker, found: false, error: `HTTP ${status}` };
  try {
    const json = JSON.parse(body);
    if (json?.error) return { source: 'finnhub', ticker, found: false, error: json.error };
    const earnings = json?.earningsCalendar || [];
    const dates = earnings.map(r => r.date).filter(Boolean).sort();
    return { source: 'finnhub', ticker, found: dates.length > 0, dates: dates.slice(0, 5) };
  } catch (e) { return { source: 'finnhub', ticker, found: false, error: 'parse: ' + e.message }; }
}

// ─── Print helpers ─────────────────────────────────────────────────────────

function printResult(r) {
  if (r.found) {
    const next = r.dates?.find(d => d >= new Date().toISOString().slice(0,10));
    const past = r.dates?.filter(d => d < new Date().toISOString().slice(0,10));
    console.log(`    ✓  ${r.dates?.slice(0,4).join(' | ')}${next ? `  ← next: ${next}` : '  (all past)'}`);
  } else {
    console.log(`    ✗  ${r.error || 'not found'}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  Earnings Data Source Comparison  ·  ' + today);
  console.log(`${'═'.repeat(72)}\n`);

  // Scoreboard: how many tickers each source covers
  const scores = { yahoo: 0, fmp: 0, 'fmp-range': 0, alphavantage: 0, finnhub: 0 };
  const futureScores = { yahoo: 0, fmp: 0, 'fmp-range': 0, alphavantage: 0, finnhub: 0 };

  for (const t of TICKERS) {
    console.log(`\n── ${t.label} ${'─'.repeat(55 - t.label.length)}`);

    // Yahoo Finance
    process.stdout.write('  Yahoo Finance  ');
    const y = await testYahoo(t.yahoo);
    printResult(y);
    if (y.found) { scores.yahoo++; if (y.dates?.some(d => d >= today)) futureScores.yahoo++; }
    await sleep(300);

    // FMP historical
    process.stdout.write('  FMP historical ');
    const f = await testFMP(t.fmp);
    printResult(f);
    if (f.found) { scores.fmp++; if (f.dates?.some(d => d >= today)) futureScores.fmp++; }
    await sleep(300);

    // FMP range
    process.stdout.write('  FMP range      ');
    const fr = await testFMPRange(t.fmp);
    printResult(fr);
    if (fr.found) { scores['fmp-range']++; if (fr.dates?.some(d => d >= today)) futureScores['fmp-range']++; }
    await sleep(300);

    // Alpha Vantage
    process.stdout.write('  AlphaVantage   ');
    const a = await testAlphaVantage(t.av);
    printResult(a);
    if (a.found) { scores.alphavantage++; if (a.dates?.some(d => d >= today)) futureScores.alphavantage++; }
    await sleep(300);

    // Finnhub
    process.stdout.write('  Finnhub        ');
    const fh = await testFinnhub(t.finnhub);
    printResult(fh);
    if (fh.found) { scores.finnhub++; if (fh.dates?.some(d => d >= today)) futureScores.finnhub++; }
    await sleep(400);
  }

  const N = TICKERS.length;
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  COVERAGE SUMMARY  (any dates / future dates)');
  console.log('─'.repeat(72));
  for (const [src, cnt] of Object.entries(scores).sort((a,b) => b[1]-a[1])) {
    const pct  = Math.round(cnt / N * 100);
    const fut  = futureScores[src];
    const fpct = Math.round(fut / N * 100);
    const bar  = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    console.log(`  ${src.padEnd(14)} ${bar} ${String(cnt).padStart(2)}/${N} (${String(pct).padStart(3)}%) · future: ${fut}/${N} (${fpct}%)`);
  }
  console.log(`${'═'.repeat(72)}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
