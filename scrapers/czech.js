/**
 * CZ — Insider Transactions Scraper
 *
 * Source: Czech National Bank (CNB) / Prague Stock Exchange (PSE)
 *
 * STATUS: Currently non-functional — no publicly accessible API exists.
 *
 * Investigated options (all blocked):
 *   - PSE (www.pse.cz): Cloudflare IP-block — ECONNRESET on all requests
 *   - CNB OAM (oam.cnb.cz): Oracle DB Forms app, TCP-resets non-Czech IPs
 *   - CNB open data portal: returns 404
 *   - Vienna Stock Exchange (PSE parent): no insider transaction API found
 *
 * To enable: either find a VPN/proxy endpoint in CZ, or implement Puppeteer
 * automation against the CNB OAM system (if it can be browser-rendered from
 * a Czech IP via a headless browser proxy).
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'CZ';
const SOURCE         = 'CNB Czech Republic / PSE';
const RETENTION_DAYS = 90;
const CURRENCY       = 'CZK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('nákup') || l.includes('buy')) return 'BUY';
  if (l.includes('dispos') || l.includes('prodej') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function tryPseApi(from, to) {
  return new Promise((resolve) => {
    const qs = `dateFrom=${from}&dateTo=${to}&category=insider&page=1&pageSize=100`;
    const req = https.get({
      hostname: 'www.pse.cz',
      path: `/en/api/announcements/insider?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.pse.cz/en/',
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

async function scrapeCZ() {
  console.log('🇨🇿  CNB Czech Republic / PSE — insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryPseApi(from, to);
  if (!data) {
    console.log('  ⚠  PSE/CNB API not accessible (endpoints return 404 or require browser session).');
    console.log('  ℹ  CNB: https://www.cnb.cz/en/financial-markets/capital-market/');
    console.log('  ℹ  PSE: https://www.pse.cz/en/');
    console.log('  ℹ  To enable: identify the PSE/CNB data API or implement Puppeteer automation.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.announcements || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.date || r.transactionDate || '').slice(0, 10) || from;
    const shares = r.quantity != null ? Math.round(Math.abs(Number(r.quantity))) : null;
    const price  = r.price != null ? Number(r.price) : null;
    const total  = (shares && price) ? Math.round(shares * price) : null;
    const fid    = `CZ-${r.id || r.isin + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || r.ticker || null,
      company:          r.issuerName || r.company || null,
      insider_name:     r.personName || r.declarant || null,
      insider_role:     translateRole(r.position || r.function) || null,
      transaction_type: mapType(r.transactionType || r.type || ''),
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.currency || CURRENCY,
      filing_url:       r.url || `https://www.pse.cz/en/`,
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

scrapeCZ().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
