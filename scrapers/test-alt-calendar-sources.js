'use strict';
const https = require('https');

function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, h: res.headers, ct: res.headers['content-type'] || '' }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message, h: {}, ct: '' }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', h: {}, ct: '' }); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extract date patterns from HTML
function extractDates(html) {
  const patterns = [
    /202[5-7]-\d{2}-\d{2}/g,
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}[,\s]+202[5-7]/g,
    /\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+202[5-7]/g,
    /\b(?:Q[1-4]|H[12])\s+202[5-7]/g,
  ];
  const all = new Set();
  for (const p of patterns) for (const m of html.matchAll(p)) all.add(m[0]);
  return [...all].sort();
}

// Look for structured data (JSON-LD, microdata)
function extractStructuredDates(html) {
  const results = [];
  const jsonLds = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of jsonLds) {
    try {
      const j = JSON.parse(m[1]);
      const str = JSON.stringify(j);
      const dates = str.match(/202[5-7]-\d{2}-\d{2}/g) || [];
      if (dates.length) results.push({ type: j['@type'], dates });
    } catch { /* skip malformed */ }
  }
  return results;
}

const TEST_TICKERS = [
  { label: 'ASML (NL)',         saSymbol: 'asml',    reuters: 'ASML.AS',  msUrl: 'ASML-HOLDING-NV-6712',   mt: 'ASML/asml-holding',    isin: 'NL0010273215', mic: 'XAMS' },
  { label: 'Vidrala (ES)',      saSymbol: 'vid',     reuters: 'VID.MC',   msUrl: 'VIDRALA-SA-50536',        mt: 'VID/vidrala',          isin: 'ES0183746314', mic: 'XMCE' },
  { label: 'LVMH (FR)',         saSymbol: 'lvmh',    reuters: 'LVMH.PA',  msUrl: 'LVMH-6584',               mt: 'MC/lvmh-moet-hennessy', isin: 'FR0000121014', mic: 'XPAR' },
  { label: 'Thermador (FR)',    saSymbol: 'thep',    reuters: 'THEP.PA',  msUrl: 'THERMADOR-GROUPE-2049050', mt: null,                   isin: 'FR0000070204', mic: 'XPAR' },
  { label: 'Prosus (NL)',       saSymbol: 'prosus',  reuters: 'PRX.AS',   msUrl: 'PROSUS-NV-32882744',      mt: null,                   isin: 'NL0013654783', mic: 'XAMS' },
];

async function main() {

  // ── 1. StockAnalysis.com ─────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  1. STOCKANALYSIS.COM');
  console.log('══════════════════════════════════════════════════════');

  for (const t of TEST_TICKERS.slice(0, 3)) {
    const url = `https://stockanalysis.com/stocks/${t.saSymbol}/financials/`;
    const r = await get(url);
    console.log(`\n${t.label} [${r.s}] ${url}`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      const ld = extractStructuredDates(r.b);
      console.log('  Date patterns:', dates.slice(0, 8).join(' | ') || 'none');
      console.log('  JSON-LD:', ld.length ? JSON.stringify(ld) : 'none');
      // Look for earnings-specific context
      const earningsCtx = [...r.b.matchAll(/.{0,60}(?:earnings|Earnings|report\s+date|results?\s+date|fiscal\s+quarter).{0,60}/g)]
        .map(m => m[0].replace(/\s+/g, ' ').trim()).slice(0, 4);
      earningsCtx.forEach(c => console.log('  ctx:', c));
      // Check for next earnings date specifically
      const nextEarnings = r.b.match(/(?:next\s+earnings|upcoming\s+earnings|earnings\s+date)[^<]{0,100}/i);
      if (nextEarnings) console.log('  NEXT EARNINGS:', nextEarnings[0].replace(/\s+/g, ' ').trim());
    } else {
      console.log('  ' + r.b.slice(0, 150));
    }
    await sleep(800);
  }

  // Also try the earnings-specific page
  console.log('\n── StockAnalysis earnings page ──');
  for (const sym of ['asml', 'lvmh']) {
    const url = `https://stockanalysis.com/stocks/${sym}/forecast/earnings/`;
    const r = await get(url);
    const dates = extractDates(r.b);
    console.log(`  ${sym} [${r.s}] earnings forecast: dates=`, dates.slice(0, 6).join(', ') || 'none');
    await sleep(600);
  }

  // ── 2. Macrotrends ───────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  2. MACROTRENDS');
  console.log('══════════════════════════════════════════════════════');

  for (const t of TEST_TICKERS.slice(0, 2)) {
    if (!t.mt) continue;
    const url = `https://www.macrotrends.net/stocks/charts/${t.mt}/earnings-per-share-diluted`;
    const r = await get(url, { 'Referer': 'https://www.macrotrends.net' });
    console.log(`\n${t.label} [${r.s}]`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      console.log('  Date patterns:', dates.slice(0, 8).join(' | ') || 'none');
      // Look for quarterly data table
      const tableMatch = r.b.match(/(?:Announcement\s+Date|Report\s+Date|Quarter\s+End)[^<]{0,500}/gi) || [];
      tableMatch.slice(0, 3).forEach(m => console.log('  table:', m.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 120)));
    } else { console.log('  ' + r.b.slice(0, 100)); }
    await sleep(800);
  }

  // ── 3. Reuters company events ─────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  3. REUTERS COMPANY EVENTS');
  console.log('══════════════════════════════════════════════════════');

  for (const t of TEST_TICKERS.slice(0, 3)) {
    const url = `https://www.reuters.com/markets/companies/${t.reuters}/events/`;
    const r = await get(url, { 'Referer': 'https://www.reuters.com' });
    console.log(`\n${t.label} [${r.s}]`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      const ld = extractStructuredDates(r.b);
      console.log('  Dates found:', dates.slice(0, 8).join(' | ') || 'none');
      if (ld.length) console.log('  JSON-LD events:', JSON.stringify(ld).slice(0, 300));
      // Look for event-related context
      const eventCtx = [...r.b.matchAll(/.{0,50}(?:earnings|dividend|annual\s+report|results|AGM|EGM).{0,50}/gi)]
        .map(m => m[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(s => s.length > 20).slice(0, 5);
      eventCtx.forEach(c => console.log('  event:', c));

      // Also check for embedded JSON data
      const dataBlocks = [...r.b.matchAll(/window\.__(?:PRELOADED_STATE|INITIAL_STATE|data)[^=]*=\s*(\{[\s\S]{50,2000}?);/g)];
      if (dataBlocks.length) console.log('  JS state data: found', dataBlocks.length, 'block(s)');

      // Try their API endpoint hinted in page
      const apiHints = [...new Set((r.b.match(/['"]\/api\/[^'"<\s]{5,80}['"]/g) || []).slice(0, 10))];
      if (apiHints.length) console.log('  API hints:', apiHints.join(', '));
    } else { console.log('  ' + r.b.slice(0, 200)); }
    await sleep(1000);
  }

  // Also try Reuters API directly
  console.log('\n── Reuters API probes ──');
  const reutersAPIs = [
    `https://www.reuters.com/companies/api/getFundamentals/?symbol=ASML.AS&type=earnings`,
    `https://www.reuters.com/finance/stocks/company-events?symbol=ASML.AS`,
    `https://www.reuters.com/markets/companies/ASML.AS/financials/earnings/`,
  ];
  for (const url of reutersAPIs) {
    const r = await get(url, { 'Referer': 'https://www.reuters.com', 'Accept': 'application/json,text/html,*/*' });
    const dates = extractDates(r.b);
    console.log(`  [${r.s}] ${url.replace('https://www.reuters.com', '')}: dates=${dates.slice(0,4).join(',') || 'none'} ct=${r.ct.slice(0,40)}`);
    await sleep(400);
  }

  // ── 4. MarketScreener ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  4. MARKETSCREENER / ZONEBOURSE');
  console.log('══════════════════════════════════════════════════════');

  for (const t of TEST_TICKERS.slice(0, 3)) {
    const url = `https://www.marketscreener.com/quote/stock/${t.msUrl}/calendar/`;
    const r = await get(url, { 'Referer': 'https://www.marketscreener.com' });
    console.log(`\n${t.label} [${r.s}] ${url.replace('https://www.marketscreener.com','')}`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      console.log('  Dates:', dates.slice(0, 10).join(' | ') || 'none');
      // Look for event table
      const calRows = [...r.b.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)]
        .map(m => m[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
        .filter(s => /202[5-7]/.test(s) && s.length > 10)
        .slice(0, 6);
      calRows.forEach(r => console.log('  row:', r.slice(0, 120)));
      if (r.b.length < 5000) console.log('  (page seems truncated — may need JS)');
    } else { console.log('  ' + r.b.slice(0, 200)); }
    await sleep(800);
  }

  // ── 5. Euronext company page HTML ─────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  5. EURONEXT COMPANY PAGE HTML');
  console.log('══════════════════════════════════════════════════════');

  for (const t of TEST_TICKERS.slice(0, 2)) {
    const url = `https://live.euronext.com/en/product/equities/${t.isin}-${t.mic}`;
    const r = await get(url, { 'Referer': 'https://live.euronext.com', 'Accept': 'text/html' });
    console.log(`\n${t.label} [${r.s}]`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      console.log('  Dates in page:', dates.slice(0, 10).join(' | ') || 'none');
      const ld = extractStructuredDates(r.b);
      if (ld.length) console.log('  JSON-LD:', JSON.stringify(ld).slice(0, 300));
      // Look for calendar/agenda widget content
      const calCtx = [...r.b.matchAll(/.{0,40}(?:calendar|agenda|financial.event|result|earnings).{0,40}/gi)]
        .map(m => m[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
        .filter(s => s.length > 15 && /\d/.test(s)).slice(0, 5);
      calCtx.forEach(c => console.log('  cal:', c));
    } else { console.log('  ' + r.b.slice(0, 100)); }
    await sleep(600);
  }

  // ── 6. Simply Wall St ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  6. SIMPLY WALL ST');
  console.log('══════════════════════════════════════════════════════');

  const swsUrls = [
    'https://simplywall.st/stocks/nl/tech/nasdaq-asml/asml-holding-shares',
    'https://simplywall.st/stocks/nl/tech/ams-asml/asml-holding-shares',
  ];
  for (const url of swsUrls) {
    const r = await get(url, { 'Referer': 'https://simplywall.st' });
    console.log(`[${r.s}] ${url.replace('https://simplywall.st','')}`);
    if (r.s === 200) {
      const dates = extractDates(r.b);
      console.log('  Dates:', dates.slice(0, 8).join(' | ') || 'none');
      const nextMatch = r.b.match(/(?:next\s+earnings|upcoming\s+report|earnings?\s+date)[^<]{0,200}/i);
      if (nextMatch) console.log('  NEXT:', nextMatch[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 150));
    } else { console.log('  ' + r.b.slice(0, 100)); }
    await sleep(600);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  DONE — proceeding to Option 7 (pattern detection)');
  console.log('══════════════════════════════════════════════════════\n');
  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
