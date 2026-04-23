/**
 * IE — Insider Transactions Scraper
 *
 * Source: Central Bank of Ireland (CBI) / Euronext Dublin (ISE)
 * URL: https://www.centralbank.ie/markets-and-securities/market-disclosure
 * Alternative: https://live.euronext.com/en/markets/dublin
 *
 * Irish MAR Article 19 notifications are submitted to the CBI and then published
 * via the ISE (Irish Stock Exchange, now Euronext Dublin) announcement system.
 * Accessing the ISE redirects to live.euronext.com which is a JS-rendered Drupal SPA.
 *
 * The Euronext platform requires a browser session — all programmatic requests
 * return the anti-bot HTML shell.
 *
 * To enable: implement Puppeteer automation for live.euronext.com with market=XDUB
 * and filter for MAR/insider transaction announcement categories.
 *
 * Alternatively: scrape the CBI's own disclosure register if a public data export
 * becomes available at https://www.centralbank.ie/markets-and-securities
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'IE';
const SOURCE         = 'CBI Ireland / Euronext Dublin';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function tryEuronextDublin(from, to) {
  return new Promise((resolve) => {
    const qs = `market=XDUB&category=insider&dateFrom=${from}&dateTo=${to}&page=0&pageSize=100`;
    const req = https.get({
      hostname: 'live.euronext.com',
      path: `/api/v1/market-notices?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://live.euronext.com/en/markets/dublin',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeIE() {
  console.log('🇮🇪  CBI Ireland / Euronext Dublin — MAR insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryEuronextDublin(from, to);
  if (!data) {
    console.log('  ⚠  Euronext Dublin API not accessible (JS-rendered SPA or API endpoint unknown).');
    console.log('  ℹ  CBI Portal: https://www.centralbank.ie/markets-and-securities/market-disclosure');
    console.log('  ℹ  ISE/Euronext: https://live.euronext.com/en/markets/dublin');
    console.log('  ℹ  To enable: implement Puppeteer for Euronext Dublin announcements.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.announcements || data.results || data.notices || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.date || r.publishDate || r.publishedAt || '').slice(0, 10) || from;
    const fid   = `IE-${r.id || r.announcementId || r.issuerCode + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.transactionType || r.type || r.headline || '').toLowerCase();
      if (t.includes('acqui') || t.includes('purchase') || t.includes('buy')) return 'BUY';
      if (t.includes('dispos') || t.includes('sale') || t.includes('sell')) return 'SELL';
      return 'UNKNOWN';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.issuerCode || r.isin || null,
      company:          r.issuerName || r.company || null,
      insider_name:     r.personName || r.declarant || null,
      insider_role:     translateRole(r.position) || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           r.quantity != null ? Math.round(Math.abs(Number(r.quantity))) : null,
      price_per_share:  r.price != null ? Number(r.price) : null,
      total_value:      r.amount != null ? Math.round(Math.abs(Number(r.amount))) : null,
      currency:         CURRENCY,
      filing_url:       r.url || `https://live.euronext.com/en/markets/dublin`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapeIE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
