/**
 * NO — Insider Transactions Scraper
 *
 * Source: Oslo Bors / Euronext Oslo — NewsWeb (newsweb.oslobors.no)
 * Backend API: https://obns-api.dev.euronext.cloud/v1/newsreader/list
 *
 * The NewWeb SPA calls the obns-api.dev.euronext.cloud backend for news lists.
 * Category for insider transactions: INSI (Innsidehandel / Insider Trading).
 *
 * API query format:
 *   GET /v1/newsreader/list?category=<cat_id>&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&market=oslo_bors
 *
 * Note: obns-api.dev.euronext.cloud does NOT resolve via public DNS from WSL2.
 * It resolves on GitHub Actions (Azure Linux) and from EU VPS hosts.
 *
 * Transaction details are in PDF attachments; structured data fetched via
 * /v1/newsreader/message?messageId=<id> endpoint.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors Norway / Euronext';
const RETENTION_DAYS = 14;
const CURRENCY       = 'NOK';
const API_HOST       = 'obns-api.dev.euronext.cloud';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('kjøp') || l.includes('erverv') || l.includes('acqui') || l.includes('buy')) return 'BUY';
  if (l.includes('salg') || l.includes('avhend') || l.includes('dispos') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function fetchList(qs) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path: `/v1/newsreader/list?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
        'Referer': 'https://newsweb.oslobors.no/',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => {
      if (err.code === 'ENOTFOUND') resolve('dns-error');
      else resolve(null);
    });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

function fetchCategories() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path: '/v1/newsreader/categories',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => {
      if (err.code === 'ENOTFOUND') resolve('dns-error');
      else resolve(null);
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeNO() {
  console.log('🇳🇴  Oslo Bors Norway — insider transactions (INSI category)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // First, try to resolve categories to find the INSI category code
  // (falls back to trying 'INSI' directly as category string)
  const cats = await fetchCategories();
  if (cats === 'dns-error') {
    console.log(`  ⚠  Oslo Bors API (${API_HOST}) DNS not resolvable from this network.`);
    console.log(`  ℹ  This API resolves from GitHub Actions and EU VPS — will work in CI.`);
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  // Find INSI category ID (or null if categories unavailable)
  let insiCategoryId = null;
  if (cats && Array.isArray(cats)) {
    const insiCat = cats.find(c =>
      (c.shortName || c.code || c.id || '').toUpperCase() === 'INSI' ||
      (c.name || c.englishName || '').toLowerCase().includes('insider')
    );
    if (insiCat) {
      insiCategoryId = insiCat.id || insiCat.code || insiCat.shortName;
      console.log(`  Found INSI category: ${insiCategoryId}`);
    }
  }

  // Fetch insider transaction list
  const catParam = insiCategoryId || 'INSI';
  const qs = `category=${encodeURIComponent(catParam)}&fromDate=${from}&toDate=${to}&market=oslo_bors`;
  const data = await fetchList(qs);

  if (data === 'dns-error') {
    console.log(`  ⚠  Oslo Bors API DNS not resolvable. 0 rows saved.`);
    return { saved: 0 };
  }
  if (!data) {
    // Try without market filter (may return all Euronext markets)
    console.log(`  First attempt failed — retrying without market filter…`);
    const data2 = await fetchList(`category=${encodeURIComponent(catParam)}&fromDate=${from}&toDate=${to}`);
    if (!data2 || data2 === 'dns-error') {
      console.log('  ⚠  Oslo Bors NewsWeb API returned non-JSON or connection failed.');
      console.log('  ℹ  Portal: https://newsweb.oslobors.no/');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }
  }

  const messages = (data && (data.messages || data.items || (Array.isArray(data) ? data : []))) || [];
  if (!messages.length) {
    console.log('  No INSI messages in window.');
    return { saved: 0 };
  }

  console.log(`  ${messages.length} messages found`);
  const seen = new Set();
  const dbRows = [];

  for (const m of messages) {
    const txIso = (m.time || m.publishedTime || m.date || '').slice(0, 10) || from;
    const fid   = `NO-${m.messageId || m.id || (m.issuer + '-' + txIso)}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           m.issuer || m.issuerCode || '',
      company:          m.issuerFullName || m.issuerName || m.issuer || null,
      insider_name:     null,
      insider_role:     null,
      transaction_type: mapType(m.messageTitle || m.headline || m.title || ''),
      transaction_date: txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       `https://newsweb.oslobors.no/message/${m.messageId || m.id || ''}`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapeNO().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
