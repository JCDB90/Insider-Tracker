/**
 * SG — Insider Transactions Scraper
 *
 * Source: SGX Singapore — Singapore Exchange
 * URL: https://www.sgx.com/securities/company-announcements
 * API: https://api.sgx.com/securities/v1.0/securities-announcements (requires auth token — 403)
 *
 * SGX company announcements include Form 5 (Notice of Insider Dealings) filings.
 * The SGX website is a React SPA; the API requires authentication (returns 403
 * for unauthenticated requests).
 *
 * The MAS (Monetary Authority of Singapore) maintains an insider register but
 * does not publish a machine-readable API.
 *
 * To enable: obtain SGX API credentials or implement Puppeteer to scrape the
 * SGX company announcements filtered by "Form 5" or "Insider Dealings" category.
 *
 * SGX announcement categories: ANNC_TYPE=23 (Acquisitions & Disposals — director dealings)
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'SG';
const SOURCE         = 'SGX Singapore';
const RETENTION_DAYS = 14;
const CURRENCY       = 'SGD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('purchase') || l.includes('buy') || l.includes('subscribe')) return 'BUY';
  if (l.includes('dispos') || l.includes('sale') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function trySgxApi(from, to) {
  return new Promise((resolve) => {
    // Try the public SGX API endpoint — returns 403 without auth
    const qs = `pageStart=1&pageSize=100&category=Acquisitions+Disposals&startDate=${from}&endDate=${to}`;
    const req = https.get({
      hostname: 'api.sgx.com',
      path: `/securities/v1.0/securities-announcements/all?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sgx.com/',
        'Origin': 'https://www.sgx.com',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 401) return resolve('auth-required');
        if (res.statusCode !== 200 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeSG() {
  console.log('🇸🇬  SGX Singapore — insider dealings (Form 5 / Acquisitions & Disposals)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const result = await trySgxApi(from, to);
  if (result === 'auth-required') {
    console.log('  ⚠  SGX API requires authentication (HTTP 403).');
    console.log('  ℹ  Portal: https://www.sgx.com/securities/company-announcements');
    console.log('  ℹ  To enable: obtain SGX API key or implement Puppeteer for the SGX website.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }
  if (!result) {
    console.log('  ⚠  SGX API not accessible (React SPA or connection issue).');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = result.items || result.data || result.announcements || (Array.isArray(result) ? result : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.announcementDate || r.publishedDate || r.date || '').slice(0, 10) || from;
    const fid    = `SG-${r.announcementId || r.id || r.issuerCode + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.issuerCode || r.stockCode || null,
      company:          r.issuerName || r.companyName || null,
      insider_name:     r.personName || null,
      insider_role:     translateRole(r.position) || null,
      transaction_type: mapType(r.category || r.announcementType || r.headline || ''),
      transaction_date: txIso,
      shares:           r.noOfShares != null ? Math.round(Math.abs(Number(r.noOfShares))) : null,
      price_per_share:  r.price != null ? Number(r.price) : null,
      total_value:      r.amount != null ? Math.round(Math.abs(Number(r.amount))) : null,
      currency:         CURRENCY,
      filing_url:       r.url || r.pdfLink || `https://www.sgx.com/securities/company-announcements`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeSG().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
