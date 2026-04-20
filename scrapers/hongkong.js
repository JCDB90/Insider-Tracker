/**
 * HK — Insider Transactions Scraper
 *
 * Source: HKEX Hong Kong — HKEXnews
 * URL: https://www.hkexnews.hk/listedco/listconews/advancedsearch/
 * API: https://www1.hkexnews.hk/search/titleSearchServlet.do
 *
 * HKEX Form 3 (Directors' Interests) disclosures are published via HKEXnews.
 * The titleSearchServlet.do endpoint accepts POST requests with category filter D04
 * (which covers director/substantial shareholder dealing notifications).
 *
 * Testing showed:
 *   - GET requests return HTTP 405 (Method Not Allowed)
 *   - POST requests return HTTP 200 but with 0 results for 2025–2026 dates
 *   - The endpoint may require a specific ISIN or company code (not bulk search)
 *
 * To enable: test with specific HSI constituent ISIN codes to confirm data is
 * available, or implement Puppeteer to use the advanced search form.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'HK';
const SOURCE         = 'HKEX Hong Kong';
const RETENTION_DAYS = 90;
const CURRENCY       = 'HKD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function hkexDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('purchase') || l.includes('buy')) return 'BUY';
  if (l.includes('dispos') || l.includes('sale') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function searchHkex(fromDate, toDate) {
  return new Promise((resolve) => {
    const body = [
      `lang=EN`,
      `category=0`,
      `subcategory=D`,
      `mbNumber=`,
      `dateRange=custom`,
      `fromDate=${fromDate}`,
      `toDate=${toDate}`,
      `keyword=`,
      `t1code=D04`,
      `t2Gcode=`,
      `t2code=`,
      `rowRange=100`,
      `startRow=1`,
    ].join('&');

    const req = https.request({
      hostname: 'www1.hkexnews.hk',
      path: '/search/titleSearchServlet.do',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json, text/javascript, */*',
        'Referer': 'https://www.hkexnews.hk/listedco/listconews/advancedsearch/search_active_main.aspx',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const parsed = JSON.parse(d);
          resolve(parsed);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function scrapeHK() {
  console.log('🇭🇰  HKEX Hong Kong — Form 3 director dealings (titleSearchServlet)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = hkexDate(co);
  const to   = hkexDate(new Date());
  console.log(`  Fetching D04 disclosures ${from} → ${to}…`);

  const data = await searchHkex(from, to);
  if (!data) {
    console.log('  ⚠  HKEX API not accessible or returned non-JSON.');
    console.log('  ℹ  Portal: https://www.hkexnews.hk/listedco/listconews/advancedsearch/');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const total = parseInt(data.recordCnt || data.total || '0', 10);
  const items = data.result || data.results || [];
  console.log(`  HKEX returned: ${total} total, ${items.length} in page`);

  if (!items.length) {
    if (total === 0) {
      console.log('  ⚠  HKEX returned 0 results. The D04 category may not support bulk date search.');
      console.log('  ℹ  To enable bulk scraping: test with specific HSI constituent ISIN codes.');
    } else {
      console.log('  No items in response despite non-zero total.');
    }
    return { saved: 0 };
  }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const rawDate = r.DATE_TIME || r.releaseTime || r.publishDate || '';
    const txIso   = rawDate.slice(0, 10) || isoDate(co);
    const fid     = `HK-${r.NEWS_ID || r.id || r.STOCK_CODE + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.STOCK_CODE || r.stockCode || null,
      company:          r.STOCK_NAME || r.companyName || null,
      insider_name:     null,   // not available in list endpoint
      insider_role:     null,
      transaction_type: mapType(r.HEADLINE || r.headline || ''),
      transaction_date: txIso,
      shares:           null,   // only in the filing PDF
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       r.FILE_LINK
        ? `https://www1.hkexnews.hk${r.FILE_LINK}`
        : `https://www.hkexnews.hk/listedco/listconews/advancedsearch/`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapeHK().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
