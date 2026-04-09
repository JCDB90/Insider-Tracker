/**
 * FI — Insider Transactions Scraper
 *
 * Source: Finanssivalvonta (FIN-FSA) / Nasdaq Helsinki
 * URL: https://www.finanssivalvonta.fi/en/listed-companies/market-abuse-regulation/managers-transactions/
 * Alternative: Nasdaq OMX Nordic — Helsinki (XHEL)
 *
 * FIN-FSA's insider transaction pages return 404 for all specific paths.
 * Finnish insider transactions (Johtotehtävien henkilöiden liiketoimet) are
 * published via Nasdaq Helsinki company announcements, category = insider.
 *
 * Nasdaq OMX Nordic provides a unified API for all Nordic exchanges.
 * API: https://www.nasdaqomxnordic.com/api/v1/news?exchange=XHEL&category=9
 *
 * Fields (from announcements): issuer, title, date, PDF link
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'FI';
const SOURCE         = 'Finanssivalvonta Finland / Nasdaq Helsinki';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('osto') || l.includes('merkintä') || l.includes('grant')) return 'BUY';
  if (l.includes('dispos') || l.includes('myynti') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function fetchNasdaqHEL(from, to) {
  return new Promise((resolve) => {
    const qs = `exchange=XHEL&category=9&startDate=${from}&endDate=${to}&start=0&limit=100`;
    const req = https.get({
      hostname: 'www.nasdaqomxnordic.com',
      path: `/api/v1/news?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nasdaqomxnordic.com/',
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

async function scrapeFI() {
  console.log('🇫🇮  Finanssivalvonta Finland / Nasdaq Helsinki — insider dealings');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} via Nasdaq OMX Nordic (XHEL)…`);

  const data = await fetchNasdaqHEL(from, to);
  if (!data) {
    console.log('  ⚠  Nasdaq OMX Nordic API not accessible.');
    console.log('  ℹ  FIN-FSA portal: https://www.finanssivalvonta.fi/en/listed-companies/market-abuse-regulation/managers-transactions/');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.items || data.news || data.results || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.publishedDate || r.date || r.published || '').slice(0, 10) || from;
    const fid   = `FI-${r.id || r.messageId || r.issuer + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.issuerCode || r.ticker || null,
      company:          r.issuerName || r.company || null,
      insider_name:     null,
      insider_role:     null,
      transaction_type: mapType(r.category || r.headline || ''),
      transaction_date: txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       r.url || r.link || `https://www.nasdaqomxnordic.com/news/companynews`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapeFI().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
