/**
 * LU — Insider Transactions Scraper
 *
 * Source: CSSF Luxembourg — Commission de Surveillance du Secteur Financier
 * URL: https://www.cssf.lu/en/supervision/financial-markets/
 * Alternative: Luxembourg Stock Exchange (LuxSE) announcements
 *
 * CSSF does not publish a machine-readable insider transaction register.
 * MAR Article 19 notifications for Luxembourg-listed stocks are published via
 * the LuxSE (Bourse de Luxembourg) announcements system.
 *
 * LuxSE API: https://www.luxse.com/api/announcements/search
 * Category filter for insider: type="DIR" or similar
 *
 * To enable: reverse-engineer the LuxSE announcements API or implement Puppeteer.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'LU';
const SOURCE         = 'CSSF Luxembourg / LuxSE';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function tryLuxSeApi(from, to) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'INSIDER', dateFrom: from, dateTo: to, page: 0, size: 100,
    });
    const req = https.request({
      hostname: 'www.luxse.com',
      path: '/api/announcements/search',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': 'https://www.luxse.com/',
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
    req.write(body);
    req.end();
  });
}

async function scrapeLU() {
  console.log('🇱🇺  CSSF Luxembourg / LuxSE — insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryLuxSeApi(from, to);
  if (!data) {
    console.log('  ⚠  LuxSE API not accessible (endpoint unknown or requires browser session).');
    console.log('  ℹ  CSSF: https://www.cssf.lu/en/supervision/financial-markets/');
    console.log('  ℹ  LuxSE: https://www.luxse.com/');
    console.log('  ℹ  To enable: identify the LuxSE announcements API endpoint or use Puppeteer.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.content || data.announcements || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.date || r.publishDate || r.publishedAt || '').slice(0, 10) || from;
    const fid   = `LU-${r.id || r.isin + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.transactionType || r.type || '').toLowerCase();
      if (t.includes('acqui') || t.includes('buy') || t.includes('souscri')) return 'BUY';
      if (t.includes('dispos') || t.includes('sell') || t.includes('cessi')) return 'SELL';
      return 'UNKNOWN';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || r.issuerCode || null,
      company:          r.issuerName || r.company || null,
      insider_name:     r.personName || r.declarant || null,
      insider_role:     r.position || r.function || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           r.quantity != null ? Math.round(Math.abs(Number(r.quantity))) : null,
      price_per_share:  r.price != null ? Number(r.price) : null,
      total_value:      r.amount != null ? Math.round(Math.abs(Number(r.amount))) : null,
      currency:         r.currency || CURRENCY,
      filing_url:       r.url || `https://www.luxse.com/`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapeLU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
