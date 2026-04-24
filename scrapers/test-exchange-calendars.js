'use strict';
/**
 * Test official European exchange earnings calendar sources.
 */
const https = require('https');

function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, ct: res.headers['content-type'] || '', h: res.headers }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message, ct: '', h: {} }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', ct: '', h: {} }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function probe(label, url, extraHeaders = {}) {
  return get(url, extraHeaders).then(r => {
    const isJson = r.ct.includes('json');
    let body = r.b.slice(0, 400).replace(/\s+/g, ' ');
    // Try to detect useful data
    let hasData = false;
    if (isJson && r.s === 200) {
      try {
        const j = JSON.parse(r.b);
        const arr = Array.isArray(j) ? j : (j.data || j.results || j.items || j.earningsCalendar || j.aaData || []);
        if (Array.isArray(arr) && arr.length > 0) { hasData = true; body = `${arr.length} items · sample: ` + JSON.stringify(arr[0]).slice(0, 200); }
        else body = JSON.stringify(j).slice(0, 300);
      } catch { /* keep raw */ }
    }
    const icon = r.s === 200 ? (hasData ? '✅' : '⚠ ') : '❌';
    console.log(`  ${icon} [${r.s}] ${label}`);
    if (r.s !== 200 || hasData || !isJson) console.log(`     ${body}`);
    return { s: r.s, hasData, raw: r.b, ct: r.ct, headers: r.h };
  });
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const y = today.slice(0, 4);
  const m = today.slice(0, 7); // YYYY-MM
  const in3m = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const in6m = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);

  // ── 1. EURONEXT ──────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  1. EURONEXT (NL FR BE PT IE)');
  console.log('══════════════════════════════════════════════');

  await probe('IPO calendar endpoint (test format)',
    `https://live.euronext.com/api/ipo-calendar/results?isinCode=&selectedMic=XPAR&selectedMonth=${m}`);

  await probe('Results calendar – XPAR',
    `https://live.euronext.com/en/pd/data/company-results-calendar?mics=XPAR&iDisplayLength=100&iDisplayStart=0&dateFrom=${today}&dateTo=${in6m}`,
    { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://live.euronext.com' });
  await sleep(300);

  await probe('Results calendar – all markets',
    `https://live.euronext.com/en/pd/data/company-results-calendar?mics=XPAR,XAMS,XBRU,XLIS,XOSL&iDisplayLength=200&iDisplayStart=0`,
    { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://live.euronext.com' });
  await sleep(300);

  // Try the Euronext website search API
  await probe('Euronext instruments search (ASML)',
    `https://live.euronext.com/en/pd/data/stocks?mics=XAMS&iDisplayLength=5&sSearch=ASML`,
    { 'X-Requested-With': 'XMLHttpRequest' });
  await sleep(300);

  // Check the actual calendar page for clues about the real endpoint
  const calPage = await get('https://live.euronext.com/en/market-data/calendar-and-events/earnings-calendar');
  console.log(`  🔍 Earnings calendar page HTTP: ${calPage.s} len=${calPage.b.length}`);
  // Look for API endpoints in the HTML
  const apiMatches = [...new Set((calPage.b.match(/\/api\/[^\s"'<>?]+/g) || []).slice(0, 15))];
  if (apiMatches.length) console.log('     API paths found:', apiMatches.join(', '));

  await sleep(300);

  // Try Euronext's financial events endpoint
  await probe('Euronext financial events',
    `https://live.euronext.com/en/pd/data/agm-calendar?mics=XPAR,XAMS,XBRU&iDisplayLength=100&dateFrom=${today}&dateTo=${in6m}`,
    { 'X-Requested-With': 'XMLHttpRequest' });
  await sleep(300);

  // Euronext OpenFIGI-style instrument page
  await probe('Euronext company page ASML (NL0010273215)',
    'https://live.euronext.com/en/product/equities/NL0010273215-XAMS/asml-holding',
    { 'Accept': 'text/html' });
  await sleep(300);

  // ── 2. NASDAQ NORDIC ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  2. NASDAQ NORDIC (SE DK FI NO)');
  console.log('══════════════════════════════════════════════');

  await probe('Nasdaq Nordic financial reports API',
    `https://www.nasdaqomxnordic.com/webproxy/DataFeedProxy.aspx?SubSystem=Calendar&Action=GetResults&Offset=0&Limit=200&FromDate=${today}&ToDate=${in6m}&Exchanges=0,1,2,3&IsJson=1`);
  await sleep(300);

  await probe('Nasdaq Nordic financial reports (POST fallback GET)',
    `https://www.nasdaqomxnordic.com/shares/microsite?Instrument=SSE17994&type=earnings`,
    { 'Accept': 'text/html' });
  await sleep(300);

  // Try the new Nasdaq Nordic API
  await probe('Nasdaq Nordic events',
    `https://api.nasdaq.com/api/calendar/earnings?date=${today}`,
    { 'Origin': 'https://www.nasdaq.com', 'Referer': 'https://www.nasdaq.com/' });
  await sleep(300);

  // Oslo Bors category for financial reports (we already use their news API)
  await probe('Oslo Bors category 7 (financial results)',
    `https://api3.oslo.oslobors.no/v1/newsreader/list?category=7&fromDate=${today}&toDate=${in6m}`,
    { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' });
  await sleep(300);

  await probe('Oslo Bors category 4 (interim/annual)',
    `https://api3.oslo.oslobors.no/v1/newsreader/list?category=4&fromDate=${today}&toDate=${in3m}`,
    { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' });
  await sleep(300);

  // ── 3. DEUTSCHE BÖRSE / XETRA ─────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  3. DEUTSCHE BÖRSE / XETRA (DE)');
  console.log('══════════════════════════════════════════════');

  await probe('Boerse Frankfurt events',
    `https://api.boerse-frankfurt.de/v1/data/calendar?type=EARNINGS&from=${today}&to=${in6m}`);
  await sleep(300);

  await probe('Boerse Frankfurt instruments SAP',
    `https://api.boerse-frankfurt.de/v1/data/price_information?isin=DE0007164600&mic=XETR`);
  await sleep(300);

  await probe('Deutsche Börse corporate calendar',
    `https://www.xetra.com/xetra-en/newsroom/market-data/corporate-calendar`,
    { 'Accept': 'text/html' });
  await sleep(300);

  // Try the Xetra data API
  await probe('Xetra instruments data',
    `https://api.deutsche-boerse.com/prod/v1/corporate-actions?date=${today}&type=EARNINGS`,
    { 'X-DBP-APIKEY': '' });
  await sleep(300);

  // ── 4. BOLSA MADRID / BME ────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  4. BOLSA MADRID / BME (ES)');
  console.log('══════════════════════════════════════════════');

  await probe('BME financial calendar',
    `https://www.bolsasymercados.es/bme-exchange/en/Market-Rates-Stats/Companies/Financial-Calendar`);
  await sleep(300);

  // BME has an AJAX endpoint
  await probe('BME calendar AJAX',
    `https://www.bolsasymercados.es/bme-exchange/docs/esp/frames/resultados.aspx`,
    { 'X-Requested-With': 'XMLHttpRequest' });
  await sleep(300);

  await probe('CNMV financial calendar',
    `https://www.cnmv.es/portal/Publicaciones/PublicacionesGo.aspx?id=3`,
    { 'Accept': 'text/html' });
  await sleep(300);

  // ── 5. BORSA ITALIANA ────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  5. BORSA ITALIANA (IT)');
  console.log('══════════════════════════════════════════════');

  await probe('Borsa Italiana calendar',
    `https://www.borsaitaliana.it/borsa/azioni/calendario-societario.html?lang=en`);
  await sleep(300);

  await probe('Borsa Italiana API events',
    `https://api.borsaitaliana.it/api/financialcalendar/events?lang=en&dateFrom=${today}&dateTo=${in3m}`);
  await sleep(300);

  // ── 6. AGGREGATORS ───────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  6. AGGREGATORS / ALTERNATIVE SOURCES');
  console.log('══════════════════════════════════════════════');

  // MarketScreener has a comprehensive EU earnings calendar
  await probe('MarketScreener calendar',
    `https://www.marketscreener.com/stock-exchange/results-calendar/?list=1`);
  await sleep(300);

  // Zonebourse (French, covers EU)
  await probe('Zonebourse calendar',
    `https://www.zonebourse.com/ajax/calendar/?type=resultats&from=${today}&to=${in3m}`);
  await sleep(300);

  // Simply Wall St (check their data API)
  await probe('Simply Wall St graphql',
    `https://api.simplywall.st/graphql`,
    { 'Content-Type': 'application/json', 'Accept': 'application/json' });
  await sleep(300);

  // TradingEconomics (has EU earnings calendar)
  await probe('TradingEconomics earnings EU',
    `https://tradingeconomics.com/calendar/earnings?c=eur`,
    { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
  await sleep(300);

  // Earnings Whispers (has some EU data)
  await probe('EarningsWhispers search ASML',
    `https://api.earningswhispers.com/api/search?q=ASML`);
  await sleep(300);

  // Wallstreetmojo / Macroaxis EU earnings
  await probe('Macroaxis ASML calendar',
    `https://www.macroaxis.com/financial_statements/ASML`);
  await sleep(300);

  // ── 7. ALTERNATIVE APPROACH: SCRAPE EURONEXT PAGE ─────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log('  7. EURONEXT COMPANY PAGE SCRAPING');
  console.log('══════════════════════════════════════════════');

  // Euronext company pages contain reporting dates - check ASML
  const asmlPage = await get('https://live.euronext.com/en/product/equities/NL0010273215-XAMS');
  console.log(`  🔍 ASML page: HTTP ${asmlPage.s}, len=${asmlPage.b.length}`);
  if (asmlPage.s === 200) {
    // Look for date patterns
    const dates = [...new Set((asmlPage.b.match(/202[5-7]-\d{2}-\d{2}/g) || []))].sort();
    console.log('     Date strings in page:', dates.slice(0, 10).join(', ') || 'none');
    // Look for "earnings", "results", "annual", "quarterly"
    const earningsCtx = (asmlPage.b.match(/.{0,50}(?:earnings|Earnings|results|Results|Résultats|annual|quarterly).{0,50}/g) || []).slice(0, 4);
    earningsCtx.forEach(c => console.log('     →', c.replace(/\s+/g, ' ').trim()));
  }
  await sleep(300);

  // ASML investor relations page
  const asmlIR = await get('https://www.asml.com/en/investors/financial-calendar');
  console.log(`\n  🔍 ASML IR financial calendar: HTTP ${asmlIR.s}`);
  if (asmlIR.s === 200) {
    const dates = [...new Set((asmlIR.b.match(/202[5-7]-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d+[,\s]+202[5-7]/g) || []))];
    console.log('     Dates found:', dates.slice(0, 6).join(', ') || 'none');
  }
  await sleep(300);

  // Check if Euronext has a company-specific calendar endpoint
  // Try with company ID / ISIN
  const euCompanyIds = [
    { name: 'ASML', url: 'https://live.euronext.com/en/product/equities/NL0010273215-XAMS/asml-holding/calendar' },
    { name: 'ASML-2', url: 'https://live.euronext.com/api/company/NL0010273215/events' },
    { name: 'ASML-3', url: 'https://live.euronext.com/en/ajax/getCompanyCalendarData/NL0010273215' },
    { name: 'ASML-4', url: 'https://live.euronext.com/en/ajax/getCompanyAgenda/NL0010273215-XAMS' },
  ];

  for (const { name, url } of euCompanyIds) {
    await probe(name, url, { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://live.euronext.com' });
    await sleep(200);
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  DONE');
  console.log('══════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
