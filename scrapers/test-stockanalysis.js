'use strict';
const https = require('https');
function get(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120',
        'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, b: d }));
    });
    req.on('error', e => resolve({ s: 0, b: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ s: 0, b: 'TIMEOUT' }); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // ASML main page
  const r1 = await get('https://stockanalysis.com/stocks/asml/');
  console.log('ASML main page HTTP:', r1.s, 'len:', r1.b.length);

  // Find "next earnings" section
  const lc = r1.b.toLowerCase();
  const idx = lc.indexOf('next earnings');
  if (idx >= 0) {
    const section = r1.b.slice(idx - 50, idx + 400).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    console.log('NEXT EARNINGS section:', section);
  } else {
    console.log('No "next earnings" found in page');
    // Look for alternatives
    const alts = ['earnings date', 'earnings release', 'report date', 'Q1 2026', 'Q2 2026'];
    for (const alt of alts) {
      const i = lc.indexOf(alt.toLowerCase());
      if (i >= 0) {
        const ctx = r1.b.slice(i, i + 200).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        console.log(alt + ':', ctx.slice(0, 120));
      }
    }
  }

  // Extract all dates
  const dates = [...new Set([
    ...(r1.b.match(/202[5-7]-\d{2}-\d{2}/g) || []),
    ...(r1.b.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+202[5-7]/g) || []),
  ])].sort();
  console.log('All dates in page:', dates.join(' | '));

  // Check JSON/svelte data in script tags
  const scripts = [...r1.b.matchAll(/<script[^>]*>([\s\S]{20,}?)<\/script>/g)];
  for (const s of scripts) {
    const c = s[1];
    if (/earningDate|nextEarning|earningsDate/i.test(c)) {
      const m = c.match(/earningDate['":\s]+['"]?([^,'"}\s]+)/i);
      if (m) console.log('earningDate in JS:', m[1]);
      console.log('JS earnings context:', c.slice(Math.max(0, c.search(/earningDate/i) - 20), c.search(/earningDate/i) + 200).replace(/\s+/g, ' '));
    }
  }

  // Check quarterly financials page
  await sleep(600);
  const r2 = await get('https://stockanalysis.com/stocks/asml/financials/?p=quarterly');
  console.log('\nASML quarterly financials HTTP:', r2.s, 'len:', r2.b.length);
  const idx2 = r2.b.toLowerCase().indexOf('earnings date');
  if (idx2 >= 0) {
    const section2 = r2.b.slice(idx2, idx2 + 300).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    console.log('Earnings date section:', section2);
  }
  // Dates in quarterly page
  const dates2 = [...new Set([
    ...(r2.b.match(/202[5-7]-\d{2}-\d{2}/g) || []),
    ...(r2.b.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+202[5-7]/g) || []),
  ])].sort();
  console.log('Dates in quarterly page:', dates2.join(' | '));

  // Test European company URLs on StockAnalysis
  await sleep(600);
  console.log('\n--- European company URL patterns ---');
  const euTests = [
    'https://stockanalysis.com/stocks/lvmh/',
    'https://stockanalysis.com/stocks/vid/',
    'https://stockanalysis.com/quote/MC.PA/',
    'https://stockanalysis.com/quote/VID.MC/',
    'https://stockanalysis.com/stocks/mc/',
    'https://stockanalysis.com/stocks/sap/',
    'https://stockanalysis.com/stocks/eni/',
  ];
  for (const url of euTests) {
    const r = await get(url);
    const found = r.s === 200;
    if (found) {
      const titles = r.b.match(/<title[^>]*>([^<]+)<\/title>/i);
      const lci = r.b.toLowerCase();
      const nextIdx = lci.indexOf('next earnings');
      let nextSection = '';
      if (nextIdx >= 0) nextSection = r.b.slice(nextIdx, nextIdx + 200).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 100);
      console.log('[' + r.s + '] ' + url.replace('https://stockanalysis.com', '') +
        ' title=' + (titles ? titles[1].slice(0, 50) : '?') +
        (nextSection ? ' NEXT_EARNINGS=' + nextSection : ''));
    } else {
      console.log('[' + r.s + '] ' + url.replace('https://stockanalysis.com', ''));
    }
    await sleep(400);
  }

  process.exit(0);
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
