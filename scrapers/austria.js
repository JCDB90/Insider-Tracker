/**
 * AT — Insider Transactions Scraper
 *
 * Source: FMA Austria — Finanzmarktaufsicht
 * URL: https://www.fma.gv.at/en/managers-transactions/
 * Alternative: Wien Börse / Euronext Vienna
 *
 * FMA Austria returns HTTP 403 for all programmatic requests (Cloudflare-protected).
 * Wien Börse (Euronext Vienna) publishes director dealings announcements but also
 * requires a browser session via the Euronext SPA.
 *
 * To enable: implement Puppeteer/Playwright with stealth plugin.
 *
 * Fields (FMA, when accessible):
 *   date, company, ISIN, person, position, type, volume, price, amount, currency
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'AT';
const SOURCE         = 'FMA Austria';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function tryFmaApi(from, to) {
  return new Promise((resolve) => {
    const qs = `dateFrom=${from}&dateTo=${to}&page=1&pageSize=100`;
    const req = https.get({
      hostname: 'www.fma.gv.at',
      path: `/en/managers-transactions/search?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html',
        'Referer': 'https://www.fma.gv.at/en/managers-transactions/',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeAT() {
  console.log('🇦🇹  FMA Austria — managers transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryFmaApi(from, to);
  if (!data) {
    console.log('  ⚠  FMA Austria returns HTTP 403 for programmatic access (Cloudflare protected).');
    console.log('  ℹ  Portal: https://www.fma.gv.at/en/managers-transactions/');
    console.log('  ℹ  To enable: implement Puppeteer/Playwright with Cloudflare bypass.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.transactions || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.date || r.transactionDate || '').slice(0, 10) || from;
    const shares = r.volume != null ? Math.round(Math.abs(Number(r.volume))) : null;
    const price  = r.price != null ? Number(r.price) : null;
    const total  = r.amount != null ? Math.round(Math.abs(Number(r.amount))) : (shares && price ? Math.round(shares * price) : null);
    const fid    = `AT-${r.id || r.isin + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.type || r.transactionType || '').toLowerCase();
      if (t.includes('acqui') || t.includes('kauf') || t.includes('buy')) return 'BUY';
      if (t.includes('disposa') || t.includes('verkauf') || t.includes('sell')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || null,
      company:          r.company || r.issuer || null,
      insider_name:     r.person || r.personName || null,
      insider_role:     translateRole(r.position || r.function) || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.currency || CURRENCY,
      filing_url:       `https://www.fma.gv.at/en/managers-transactions/`,
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

scrapeAT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
