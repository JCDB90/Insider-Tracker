/**
 * CH — Insider Transactions Scraper
 *
 * Source: SIX Exchange Regulation (SER-AG) — Management Transactions
 * URL: https://www.ser-ag.com/en/resources/notifications-market-supervision.html
 *
 * SER-AG publishes management transactions (Art. 56 FinfraG) in a machine-readable
 * XML/JSON feed. Attempt the known download endpoint; fall back gracefully.
 *
 * Direct download URLs tried:
 *   https://www.ser-ag.com/content/dam/downloads/notifications/management-transactions/
 *   https://www.ser-ag.com/en/resources/notifications-market-supervision/download.json
 *
 * To enable: find the exact SER-AG data export URL or implement Puppeteer to
 * interact with the table on the management transactions page.
 *
 * Fields (when accessible):
 *   date, issuer, ISIN, person, position, type, quantity, price, amount, currency
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'CH';
const SOURCE         = 'SIX Exchange Regulation';
const RETENTION_DAYS = 14;
const CURRENCY       = 'CHF';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('kauf') || l.includes('subscription') || l.includes('grant')) return 'BUY';
  if (l.includes('disposal') || l.includes('verkauf') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function trySerApi(from, to) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'www.ser-ag.com',
      path: `/api/management-transactions?dateFrom=${from}&dateTo=${to}&format=json`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.ser-ag.com/en/resources/notifications-market-supervision.html',
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

async function scrapeCH() {
  console.log('🇨🇭  SIX Exchange Regulation — management transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await trySerApi(from, to);
  if (!data) {
    console.log('  ⚠  SER-AG API endpoint not accessible (data export URL unknown or JS-rendered).');
    console.log('  ℹ  Portal: https://www.ser-ag.com/en/resources/notifications-market-supervision.html');
    console.log('  ℹ  To enable: locate the exact JSON/CSV export URL or implement Puppeteer.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.transactions || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.date || r.transactionDate || '').slice(0, 10) || from;
    const shares = r.quantity != null ? Math.round(Math.abs(Number(r.quantity))) : null;
    const price  = r.price != null ? Number(r.price) : null;
    const total  = r.amount != null ? Math.round(Math.abs(Number(r.amount))) : (shares && price ? Math.round(shares * price) : null);
    const fid    = `CH-${r.id || r.isin + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || r.valorNumber || null,
      company:          r.issuer || r.company || null,
      insider_name:     r.person || r.personName || null,
      insider_role:     r.position || r.function || null,
      transaction_type: mapType(r.type || r.transactionType || ''),
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.currency || CURRENCY,
      filing_url:       `https://www.ser-ag.com/en/resources/notifications-market-supervision.html`,
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

scrapeCH().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
