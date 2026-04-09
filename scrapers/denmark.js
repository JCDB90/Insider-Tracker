/**
 * DK — Insider Transactions Scraper
 *
 * Source: Finanstilsynet Denmark — Indsideregisteret
 * URL: https://www.finanstilsynet.dk/finansielle-temaer/kapitalmarked/mar-for-ledende-medarbejdere
 * Disclosure portal: https://offentliggoerelse.finanstilsynet.dk/
 *
 * The Danish insider disclosure portal (offentliggoerelse.finanstilsynet.dk) has no
 * IPv4 DNS record (ENODATA) — unreachable from most networks. The main Finanstilsynet
 * website is accessible but has no machine-readable data API for insider transactions.
 *
 * Nasdaq Copenhagen publishes company announcements including insider dealings, which
 * can be scraped from the Nasdaq Nordic feeds.
 *
 * To enable: use the Nasdaq OMX Nordic announcements API for XCSE (Copenhagen).
 * API: https://www.nasdaqomxnordic.com/news/companynews?exchange=XCSE&category=9
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'DK';
const SOURCE         = 'Finanstilsynet Denmark / Nasdaq Copenhagen';
const RETENTION_DAYS = 14;
const CURRENCY       = 'DKK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('køb') || l.includes('subscribe') || l.includes('grant')) return 'BUY';
  if (l.includes('dispos') || l.includes('salg') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function fetchNasdaqCPH(from, to) {
  return new Promise((resolve) => {
    // Nasdaq Nordic company news feed for Copenhagen (XCSE), category 9 = insider dealings
    const qs = `exchange=XCSE&category=9&startDate=${from}&endDate=${to}&start=0&limit=100`;
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

async function scrapeDK() {
  console.log('🇩🇰  Finanstilsynet Denmark / Nasdaq Copenhagen — insider dealings');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} via Nasdaq OMX Nordic…`);

  const data = await fetchNasdaqCPH(from, to);
  if (!data) {
    console.log('  ⚠  Nasdaq OMX Nordic API not accessible (endpoint changed or not available).');
    console.log('  ℹ  Disclosure portal: https://offentliggoerelse.finanstilsynet.dk/ (no IPv4 DNS)');
    console.log('  ℹ  Alternative: implement direct FT portal scraping with browser automation.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.items || data.news || data.results || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.publishedDate || r.date || r.published || '').slice(0, 10) || from;
    const fid    = `DK-${r.id || r.messageId || r.issuer + '-' + txIso}`;
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

scrapeDK().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
