/**
 * ZA — Insider Transactions Scraper
 *
 * Source: JSE South Africa — SENS (Securities Exchange News Service)
 * URL: https://senspdf.jse.co.za/
 * Alternative: https://www.jse.co.za/services/market-data/company-news
 *
 * Director dealings are published via SENS as "Director/Prescribed Officer Dealings"
 * announcements. The senspdf.jse.co.za portal is protected by Cloudflare (JS challenge).
 * The JSE main website returns 404 for direct API calls.
 *
 * Strate (JSE settlement authority) publishes some announcement data but the
 * API at api.strate.co.za is not publicly accessible.
 *
 * To enable: implement Puppeteer with Cloudflare bypass for senspdf.jse.co.za,
 * or obtain a JSE/SENS data subscription.
 *
 * SENS announcement categories:
 *   DIRD = Director Dealings
 *   DIRD01 = Director/Prescribed Officer Share Dealings
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'ZA';
const SOURCE         = 'JSE South Africa / SENS';
const RETENTION_DAYS = 14;
const CURRENCY       = 'ZAR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('purchase') || l.includes('buy')) return 'BUY';
  if (l.includes('dispos') || l.includes('sale') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function trySensApi(from, to) {
  return new Promise((resolve) => {
    const qs = `startDate=${from}&endDate=${to}&category=DIRD&page=1&pageSize=100`;
    const req = https.get({
      hostname: 'senspdf.jse.co.za',
      path: `/sens/search?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html',
        'Referer': 'https://senspdf.jse.co.za/',
      },
    }, res => {
      const body_chunks = [];
      res.on('data', c => body_chunks.push(c));
      res.on('end', () => {
        const d = Buffer.concat(body_chunks).toString();
        // Cloudflare challenge
        if (d.includes('cf-browser-verification') || d.includes('_cf_chl') || d.length < 1000) {
          return resolve('cloudflare');
        }
        const ct = res.headers['content-type'] || '';
        if (res.statusCode !== 200 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeZA() {
  console.log('🇿🇦  JSE South Africa — SENS director dealings');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching DIRD announcements ${from} → ${to}…`);

  const result = await trySensApi(from, to);
  if (result === 'cloudflare') {
    console.log('  ⚠  JSE SENS portal is Cloudflare-protected (JS challenge required).');
    console.log('  ℹ  SENS portal: https://senspdf.jse.co.za/');
    console.log('  ℹ  To enable: implement Puppeteer with Cloudflare bypass plugin.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }
  if (!result) {
    console.log('  ⚠  JSE SENS API not accessible.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = result.announcements || result.data || (Array.isArray(result) ? result : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.date || r.publishDate || r.announcementDate || '').slice(0, 10) || from;
    const fid    = `ZA-${r.id || r.announcementId || r.ticker + '-' + txIso}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.ticker || r.stockCode || null,
      company:          r.company || r.issuerName || null,
      insider_name:     r.directorName || r.personName || null,
      insider_role:     r.designation || r.position || null,
      transaction_type: mapType(r.dealingType || r.transactionType || r.headline || ''),
      transaction_date: txIso,
      shares:           r.numberOfShares != null ? Math.round(Math.abs(Number(r.numberOfShares))) : null,
      price_per_share:  r.price != null ? Number(r.price) : null,
      total_value:      r.value != null ? Math.round(Math.abs(Number(r.value))) : null,
      currency:         CURRENCY,
      filing_url:       r.pdfUrl || r.url || `https://senspdf.jse.co.za/`,
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

scrapeZA().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
