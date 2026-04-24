'use strict';
const https = require('https');
function get(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Accept': 'application/json,text/html,*/*', ...headers },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d, h: res.headers }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message, h: {} }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT', h: {} }); });
  });
}
function post(url, body, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': buf.length, ...headers },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT' }); });
    req.write(buf); req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const today  = new Date().toISOString().slice(0, 10);
const in6m   = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
const in12m  = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

async function main() {

  // ── 1. Oslo Bors: all categories ─────────────────────────────────────────
  console.log('\n=== Oslo Bors: categories (POST) ===');
  const obCat = await post('https://api3.oslo.oslobors.no/v1/newsreader/categories', {},
    { 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' });
  if (obCat.s === 200) {
    try {
      const j = JSON.parse(obCat.b);
      const cats = j.data?.categories || j.data || j;
      if (Array.isArray(cats)) cats.forEach(c => console.log('  id=' + (c.id || c.categoryId) + ' name=' + (c.name || c.title || JSON.stringify(c).slice(0, 60))));
      else console.log(JSON.stringify(j).slice(0, 500));
    } catch { console.log(obCat.b.slice(0, 400)); }
  } else { console.log('HTTP ' + obCat.s + ':', obCat.b.slice(0, 200)); }
  await sleep(300);

  // ── 2. Oslo Bors: scan categories for financial results ────────────────
  console.log('\n=== Oslo Bors: category scan ===');
  for (const cat of [1, 2, 3, 4, 5, 6, 7, 8, 10, 14, 16, 17, 20, 25, 30]) {
    const r = await get(
      'https://api3.oslo.oslobors.no/v1/newsreader/list?category=' + cat + '&fromDate=' + today + '&toDate=' + in6m,
      { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' }
    );
    if (r.s === 200) {
      try {
        const j = JSON.parse(r.b); const msgs = j.data?.messages || [];
        if (msgs.length > 0) console.log('  cat ' + cat + ': ' + msgs.length + ' msgs. title0=' + (msgs[0]?.title || '').slice(0, 70));
        else console.log('  cat ' + cat + ': empty');
      } catch { console.log('  cat ' + cat + ': parse error'); }
    } else { console.log('  cat ' + cat + ': HTTP ' + r.s); }
    await sleep(150);
  }

  // ── 3. Boerse Frankfurt calendar – all types ──────────────────────────
  console.log('\n=== Boerse Frankfurt /v1/data/calendar ===');
  for (const type of ['EARNINGS', 'CORPORATE_ACTIONS', 'RESULTS', 'ANNUAL_REPORT', 'AGM', 'DIVIDENDS']) {
    const r = await get('https://api.boerse-frankfurt.de/v1/data/calendar?type=' + type + '&from=' + today + '&to=' + in6m);
    try {
      const j = JSON.parse(r.b); const arr = Array.isArray(j) ? j : (j.data || j.events || j.items || []);
      console.log('  ' + type + ': HTTP ' + r.s + ' entries=' + arr.length + (arr[0] ? ' sample=' + JSON.stringify(arr[0]).slice(0, 120) : ''));
    } catch { console.log('  ' + type + ': HTTP ' + r.s, r.b.slice(0, 100)); }
    await sleep(250);
  }
  // Try without type filter
  const bf = await get('https://api.boerse-frankfurt.de/v1/data/calendar?from=' + today + '&to=' + in6m);
  console.log('  (no type): HTTP ' + bf.s, bf.b.slice(0, 300));
  await sleep(250);

  // ── 4. Euronext: parameter search ────────────────────────────────────────
  console.log('\n=== Euronext results calendar – parameter search ===');
  const euParams = [
    'mics=XPAR&iDisplayLength=50',
    'mics=XPAR&iDisplayLength=50&dateFrom=2025-01-01&dateTo=' + in12m,
    'mics=XAMS&iDisplayLength=50&dateFrom=2025-01-01&dateTo=' + in12m,
    'mics=XPAR,XAMS,XBRU,XLIS&iDisplayLength=100',
    'mics=XPAR&iDisplayLength=50&resultType=ANNUAL',
    'mics=XPAR&iDisplayLength=50&resultType=INTERIM',
  ];
  for (const p of euParams) {
    const r = await get('https://live.euronext.com/en/pd/data/company-results-calendar?' + p,
      { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://live.euronext.com', 'Accept': 'application/json' });
    try {
      const j = JSON.parse(r.b); const rows = j.aaData || [];
      console.log('  ' + p.slice(0, 70) + ' → ' + r.s + ' rows=' + rows.length + (rows[0] ? ' sample=' + JSON.stringify(rows[0]).slice(0, 120) : ''));
    } catch { console.log('  ' + p.slice(0, 70) + ' → ' + r.s, r.b.slice(0, 100)); }
    await sleep(250);
  }

  // ── 5. Zonebourse / MarketScreener deep ─────────────────────────────────
  console.log('\n=== Zonebourse / MarketScreener ===');
  const zb = await get('https://www.zonebourse.com/bourse/calendrier-resultats/');
  console.log('Zonebourse results calendar: HTTP ' + zb.s + ' len=' + zb.b.length);
  if (zb.s === 200) {
    const apis = [...new Set((zb.b.match(/['"](\/ajax\/[^'"<>?#\s]{3,60}|\/bourse\/[^'"<>?#\s]{5,60}ajax[^'"<>?#\s]{0,40})/g) || []))];
    console.log('  Ajax paths found:', apis.slice(0, 15).join(' | '));
    // Also look for JSON data embedded in page
    const jsonBlocks = zb.b.match(/window\.__[A-Z_]+\s*=\s*(\{[^;]{10,500});/g) || [];
    jsonBlocks.slice(0, 3).forEach(b => console.log('  JS var:', b.slice(0, 200)));
  }
  await sleep(300);

  // Try Zonebourse AJAX endpoint for results calendar
  const zbAjax = await get('https://www.zonebourse.com/ajax/calendrier-resultats/', {
    'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.zonebourse.com/bourse/calendrier-resultats/'
  });
  console.log('Zonebourse ajax calendar: HTTP ' + zbAjax.s, zbAjax.b.slice(0, 300));
  await sleep(300);

  // ── 6. SPECIFIC COMPANY IR PAGES ──────────────────────────────────────────
  console.log('\n=== Company IR financial calendars ===');
  const irPages = [
    { name: 'ASML', url: 'https://www.asml.com/en/investors/financial-calendar' },
    { name: 'Prosus', url: 'https://www.prosus.com/investors/financial-calendar' },
    { name: 'Flow Traders', url: 'https://www.flowtraders.com/investor-relations/financial-calendar' },
    { name: 'Industrivärden', url: 'https://www.industrivarden.se/en/investors/financial-calendar/' },
    { name: 'Jensen Group', url: 'https://www.jensengroup.com/en/investors/financial-calendar/' },
    { name: 'Vidrala', url: 'https://www.vidrala.com/en/investors/financial-information/financial-calendar/' },
    { name: 'Thermador', url: 'https://www.thermador-groupe.com/en/investors/financial-agenda' },
  ];
  for (const { name, url } of irPages) {
    const r = await get(url);
    let result = 'HTTP ' + r.s;
    if (r.s === 200) {
      const dates = [...new Set((r.b.match(/202[5-7]-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}[,\s]+202[5-7]/g) || []))].slice(0, 8);
      result += ' len=' + r.b.length + ' dates=' + (dates.length ? dates.join(', ') : 'none found');
    }
    console.log('  ' + name.padEnd(16) + ': ' + result);
    await sleep(300);
  }

  // ── 7. Euronext Newsroom / Investor Relations API ────────────────────────
  console.log('\n=== Euronext newsroom / event search ===');
  const euNews = [
    'https://live.euronext.com/en/pd/data/news?mics=XPAR,XAMS&category=RESULTS&iDisplayLength=20',
    'https://live.euronext.com/en/pd/data/news?mics=XPAR,XAMS&iDisplayLength=20&sSearch=results',
    'https://live.euronext.com/en/pd/data/corporate-actions?mics=XPAR&type=EARNINGS&iDisplayLength=20',
    'https://live.euronext.com/api/calendar/results?mics=XPAR&from=' + today + '&to=' + in6m,
    'https://live.euronext.com/api/news/search?mics=XPAR&category=annual_result',
  ];
  for (const url of euNews) {
    const r = await get(url, { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://live.euronext.com', 'Accept': 'application/json' });
    try {
      const j = JSON.parse(r.b); const rows = j.aaData || j.data || j.results || [];
      const cnt = Array.isArray(rows) ? rows.length : '?';
      console.log('  ' + url.replace('https://live.euronext.com', '').slice(0, 70) + ' → ' + r.s + ' rows=' + cnt);
    } catch { console.log('  ' + url.replace('https://live.euronext.com', '').slice(0, 70) + ' → ' + r.s, r.b.slice(0, 80)); }
    await sleep(200);
  }

  console.log('\n=== DONE ===\n');
  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
