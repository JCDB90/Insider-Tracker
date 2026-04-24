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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const today = new Date().toISOString().slice(0, 10);
const in12m = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const in24m = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
const past2y = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);

async function main() {

  // ── Oslo Bors correct category IDs ────────────────────────────────────────
  console.log('=== Oslo Bors: correct category IDs (1001=Annual, 1002=Half-year) ===');
  for (const cat of [1001, 1002]) {
    const r = await get(
      'https://api3.oslo.oslobors.no/v1/newsreader/list?category=' + cat + '&fromDate=' + today + '&toDate=' + in12m,
      { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' }
    );
    console.log('cat ' + cat + ': HTTP ' + r.s);
    if (r.s === 200) {
      try {
        const j = JSON.parse(r.b); const msgs = j.data?.messages || [];
        console.log('  messages:', msgs.length);
        msgs.slice(0, 5).forEach(m => console.log('  >', m.issuerSign, m.issuerName, m.publishedTime?.slice(0,10), m.title?.slice(0,60)));
      } catch (e) { console.log('  parse error:', e.message, r.b.slice(0, 200)); }
    } else { console.log('  body:', r.b.slice(0, 200)); }
    await sleep(300);
  }

  // Check historical data too (to verify the approach works)
  console.log('\n=== Oslo Bors: category 1001 (Annual) — past 2 years ===');
  const obHist = await get(
    'https://api3.oslo.oslobors.no/v1/newsreader/list?category=1001&fromDate=' + past2y + '&toDate=' + today,
    { 'Accept': 'application/json', 'Origin': 'https://newsweb.oslobors.no', 'Referer': 'https://newsweb.oslobors.no/' }
  );
  if (obHist.s === 200) {
    try {
      const j = JSON.parse(obHist.b); const msgs = j.data?.messages || [];
      console.log('Historical annual reports:', msgs.length);
      msgs.slice(0, 8).forEach(m => console.log(' ', m.publishedTime?.slice(0,10), m.issuerSign?.padEnd(8), m.issuerName?.slice(0,30), '|', m.title?.slice(0,50)));
    } catch (e) { console.log('parse error:', e.message); }
  }
  await sleep(300);

  // ── Nasdaq Nordic DataFeedProxy – follow redirect ────────────────────────
  console.log('\n=== Nasdaq Nordic – follow 301 redirect ===');
  const nn301 = await get(
    'https://www.nasdaqomxnordic.com/webproxy/DataFeedProxy.aspx?SubSystem=Calendar&Action=GetResults&Offset=0&Limit=100&FromDate=' + today + '&ToDate=' + in12m + '&Exchanges=0,1,2,3&IsJson=1'
  );
  console.log('HTTP:', nn301.s, 'Location:', nn301.h.location || '(none)');
  if (nn301.h.location) {
    const r2 = await get(nn301.h.location.startsWith('http') ? nn301.h.location : 'https://www.nasdaqomxnordic.com' + nn301.h.location);
    console.log('Followed → HTTP:', r2.s, r2.b.slice(0, 300));
  }
  await sleep(300);

  // Try Nasdaq Nordic with different base URL
  console.log('\n=== Nasdaq Nordic – alternative URLs ===');
  const nnUrls = [
    'https://api.nasdaqomxnordic.com/calendar/results?from=' + today + '&to=' + in12m,
    'https://www.nasdaq.com/api/calendar/earnings?date=' + today + '&market=europe',
    'https://api.nasdaq.com/api/calendar/earnings?date=' + today,
    'https://finance.nasdaq.com/api/earnings-calendar?date=' + today,
    'https://www.nasdaqomxnordic.com/shares/result-calendar',
  ];
  for (const url of nnUrls) {
    const r = await get(url, { 'Origin': 'https://www.nasdaqomxnordic.com' });
    try {
      const j = JSON.parse(r.b);
      const arr = j.data || j.rows || j.results || [];
      const cnt = Array.isArray(arr) ? arr.length : '?';
      console.log('  [' + r.s + '] ' + url.replace(/https:\/\/[^/]+/, '').slice(0, 60) + ' → items=' + cnt + (cnt > 0 ? ' sample=' + JSON.stringify(arr[0]).slice(0, 100) : ''));
    } catch { console.log('  [' + r.s + '] ' + url.replace(/https:\/\/[^/]+/, '').slice(0, 60) + ' → ' + r.b.slice(0, 80)); }
    await sleep(250);
  }

  // ── ASML IR page – extract actual dates ───────────────────────────────────
  console.log('\n=== ASML IR page – scan for event data ===');
  const asml = await get('https://www.asml.com/en/investors/financial-calendar');
  if (asml.s === 200) {
    // Look for JSON-LD structured data
    const jsonLd = asml.b.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    jsonLd.slice(0, 3).forEach(s => console.log('  JSON-LD:', s.slice(0, 300)));
    // Look for date patterns in various formats
    const datePatterns = [
      /202[5-7]-\d{2}-\d{2}/g,
      /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+202[5-7]/g,
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+202[5-7]/g,
      /\b(?:Q[1-4]|H[12])\s+202[5-7]/g,
    ];
    for (const pat of datePatterns) {
      const matches = [...new Set(asml.b.match(pat) || [])];
      if (matches.length) console.log('  Pattern ' + pat.source.slice(0, 30) + ':', matches.slice(0, 10).join(' | '));
    }
    // Look for calendar/event related JS data
    const calData = asml.b.match(/(?:calendar|events|dates|agenda)['":\s]+([[\{][^\n]{20,300})/gi) || [];
    calData.slice(0, 3).forEach(c => console.log('  calData:', c.slice(0, 200)));
    // Check for iCal link
    const ical = asml.b.match(/href="[^"]*\.ics[^"]*"/g) || [];
    if (ical.length) console.log('  iCal links:', ical.join(', '));
    // Check for any API fetch in script tags
    const fetchUrls = asml.b.match(/fetch\(['"][^'"]{10,100}['"]/g) || [];
    fetchUrls.slice(0, 5).forEach(f => console.log('  fetch():', f));
  }
  await sleep(300);

  // Check if ASML has an iCal/ICS financial calendar
  const asmlIcal = await get('https://www.asml.com/en/investors/financial-calendar?format=ics');
  console.log('\nASML iCal format:', asmlIcal.s, asmlIcal.h['content-type'], asmlIcal.b.slice(0, 200));

  // ── Euronext – company-specific agenda ───────────────────────────────────
  console.log('\n=== Euronext company-specific agenda exploration ===');
  // Try the stock details page which we know loads
  const asmlEu = await get('https://live.euronext.com/en/product/equities/NL0010273215-XAMS/asml-holding');
  if (asmlEu.s === 200) {
    // Look for agenda/calendar data in JS
    const agendaMatch = asmlEu.b.match(/(?:agenda|calendar|event|upcoming)['":\s]+([[\{][^\n]{20,400})/gi) || [];
    agendaMatch.slice(0, 3).forEach(a => console.log('  agenda:', a.slice(0, 200)));
    // Look for JSON blocks
    const jsonData = asmlEu.b.match(/(?:window|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(\{[^;]{50,500})/g) || [];
    jsonData.slice(0, 3).forEach(d => console.log('  jsVar:', d.slice(0, 200)));
    // Check for API URLs
    const apiUrls = [...new Set((asmlEu.b.match(/['"](?:\/api\/|\/en\/ajax\/)[^'"<\s]{5,80}['"]/g) || []))];
    console.log('  API URLs found:', apiUrls.slice(0, 10).join(' | '));
  }
  await sleep(300);

  // ── Euronext results calendar with CSRF token approach ────────────────────
  console.log('\n=== Euronext session-based approach ===');
  // Get the main page first to obtain session cookie
  const euMain = await get('https://live.euronext.com/en/market-data/dividends-and-results-calendar');
  console.log('Calendar page HTTP:', euMain.s, 'cookies:', (euMain.h['set-cookie'] || []).map(c => c.split(';')[0]).join(' | ').slice(0, 200));
  if (euMain.s === 200) {
    const cookieStr = (euMain.h['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    // Try the results calendar endpoint with the session cookie
    const r = await get(
      'https://live.euronext.com/en/pd/data/company-results-calendar?mics=XPAR,XAMS,XBRU&iDisplayLength=100',
      { 'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookieStr, 'Referer': 'https://live.euronext.com/en/market-data/dividends-and-results-calendar', 'Accept': 'application/json' }
    );
    try {
      const j = JSON.parse(r.b); const rows = j.aaData || [];
      console.log('With session cookie → HTTP', r.s, 'rows=', rows.length);
      if (rows.length > 0) console.log('  Sample:', JSON.stringify(rows[0]).slice(0, 200));
    } catch { console.log('With session cookie → HTTP', r.s, r.b.slice(0, 200)); }
  }

  console.log('\n=== DONE ===\n');
  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
