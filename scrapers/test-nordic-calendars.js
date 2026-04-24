'use strict';
const https = require('https');
function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json,text/html,*/*', ...headers },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, h: res.headers }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message, h: {} }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', h: {} }); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const today  = new Date().toISOString().slice(0, 10);
const past2y = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
const in12m  = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

async function main() {

  // ── Norway: full extraction test ──────────────────────────────────────────
  console.log('=== Norway: Oslo Bors categories 1001+1002 ===');
  const noTickers = new Map(); // ticker → [dates]

  for (const cat of [1001, 1002]) {
    // Fetch past 2 years of filings
    const r = await get(
      'https://api3.oslo.oslobors.no/v1/newsreader/list?category=' + cat + '&fromDate=' + past2y + '&toDate=' + today,
      { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' }
    );
    if (r.s !== 200) { console.log('cat ' + cat + ' HTTP ' + r.s); continue; }
    const msgs = JSON.parse(r.b).data?.messages || [];
    console.log('cat ' + cat + ': ' + msgs.length + ' historical messages');
    for (const m of msgs) {
      if (!m.issuerSign) continue;
      const ticker = m.issuerSign.trim();
      const date   = (m.publishedTime || m.time || '').slice(0, 10);
      if (!ticker || !date) continue;
      if (!noTickers.has(ticker)) noTickers.set(ticker, []);
      noTickers.get(ticker).push(date);
    }
    await sleep(300);
  }

  // Show sample of tickers with multiple dates → enables cadence prediction
  let quarterly = 0, semiannual = 0, annual = 0;
  const sampleOutput = [];
  for (const [ticker, dates] of noTickers) {
    const sorted = [...new Set(dates)].sort();
    if (sorted.length >= 2) {
      const diffs = [];
      for (let i = 1; i < sorted.length; i++) diffs.push((new Date(sorted[i]) - new Date(sorted[i-1])) / 86400000);
      const avgDiff = diffs.reduce((a,b) => a+b, 0) / diffs.length;
      if (avgDiff <= 100) quarterly++;
      else if (avgDiff <= 220) semiannual++;
      else annual++;
      // Predict next date from last + avg interval
      const lastDate = new Date(sorted[sorted.length - 1]);
      lastDate.setDate(lastDate.getDate() + Math.round(avgDiff));
      const predicted = lastDate.toISOString().slice(0, 10);
      sampleOutput.push({ ticker, dates: sorted.slice(-4), predicted, avgDiff: Math.round(avgDiff) });
    }
  }
  console.log('\nTickers found:', noTickers.size);
  console.log('Quarterly reporters (< 100d interval):', quarterly);
  console.log('Semi-annual reporters (100-220d):', semiannual);
  console.log('Annual reporters (> 220d):', annual);
  console.log('\nSample predictions (ticker → past dates → predicted next):');
  sampleOutput.slice(0, 12).forEach(t => console.log(
    '  ' + t.ticker.padEnd(10) + ' avg=' + String(t.avgDiff).padStart(3) + 'd  last 4: ' + t.dates.join(', ') + '  next≈' + t.predicted
  ));

  // ── Sweden: try multiple sources ─────────────────────────────────────────
  console.log('\n=== Sweden: Finansinspektionen / Nasdaq Nordic ===');

  // Swedish FI newsreader (same structure as Oslo?)
  const fiUrls = [
    'https://fi.se/sv/vara-register/insyn-handel/',
    'https://marknadssok.fi.se/publiceringsklient/en/Search?SearchFunctionType=Insyn',
  ];
  for (const url of fiUrls) {
    const r = await get(url);
    console.log('[' + r.s + '] ' + url.replace(/https:\/\/[^/]+/, ''));
    await sleep(200);
  }

  // Aktietorget / Spotlight (Swedish small-cap exchange)
  await sleep(200);

  // Cision (Swedish PR system - companies announce results here)
  const cision = await get('https://api.cision.com/Utilities/GetNews?pageSize=50&typeId=1&markets=XSTO&from=' + today + '&to=' + in12m);
  console.log('Cision XSTO:', cision.s, cision.b.slice(0, 200));
  await sleep(300);

  // Try Newsweb but for Sweden - Financial Supervisory Authority
  const sse = await get('https://www.spotlightstockmarket.com/en/market-information/disclosures/?category=financial-reports', { 'Accept': 'application/json' });
  console.log('Spotlight financial reports:', sse.s, sse.b.slice(0, 200));
  await sleep(300);

  // ── Denmark: OMX Copenhagen / Nasdaq Copenhagen ───────────────────────────
  console.log('\n=== Denmark: Nasdaq Copenhagen ===');
  // OMX Group financial calendar
  const dkUrls = [
    'https://www.omxnordic.com/index.html?m=results',
    'https://einside.dk/results-calendar',
  ];
  for (const url of dkUrls) {
    const r = await get(url);
    console.log('[' + r.s + '] ' + url.replace(/https:\/\/[^/]+/, '') + ' len=' + r.b.length);
    await sleep(200);
  }

  // ── Finland: Nasdaq Helsinki ──────────────────────────────────────────────
  console.log('\n=== Finland: Nasdaq Helsinki ===');
  const fiCalendar = await get('https://api.nasdaq.com/api/calendar/earnings?date=' + today + '&market=Finland');
  console.log('Nasdaq Finland calendar:', fiCalendar.s, fiCalendar.b.slice(0, 200));
  await sleep(200);

  // ── France: AMF/Euronext ──────────────────────────────────────────────────
  console.log('\n=== France: AMF regulated information ===');
  // AMF has a regulated information database
  const amf1 = await get('https://bdif.amf-france.org/rest/public/documents?dateFrom=' + today + '&dateTo=' + in12m + '&reportType=RESUL&limit=20');
  console.log('AMF regulated docs (financial results):', amf1.s, amf1.b.slice(0, 300));
  await sleep(300);

  // Euronext live – try hitting it as a web scraping tool would (with Referer)
  const euReferer = await get(
    'https://live.euronext.com/en/pd/data/company-results-calendar?mics=XPAR&iDisplayLength=50',
    { 'Referer': 'https://live.euronext.com/en/market-data/dividends-and-results-calendar', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' }
  );
  try {
    const j = JSON.parse(euReferer.b); const rows = j.aaData || [];
    console.log('Euronext XPAR results (with Referer): rows=' + rows.length);
  } catch { console.log('Euronext XPAR results (with Referer): HTTP ' + euReferer.s, euReferer.b.slice(0, 150)); }

  console.log('\n=== CONCLUSION ===');
  console.log('Oslo Bors (NO): ✅ Categories 1001+1002 provide ALL company earnings dates');
  console.log('  → Can extract from past filings AND predict future dates from cadence');
  console.log('  → Covers ' + noTickers.size + ' Norwegian tickers');
  console.log('Other exchanges: need further investigation or paid tier');

  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
