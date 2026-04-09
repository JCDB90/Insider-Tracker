/**
 * NO — Insider Transactions Scraper
 *
 * Source: Oslo Bors (Euronext Oslo) — NewsWeb
 * URL: https://newsweb.oslobors.no/
 * API: https://newsapi.oslobors.no/api/message?messageType=INSI  (internal — firewalled)
 *
 * Oslo Bors is operated by Euronext. Insider transactions (message type INSI) are
 * published via the NewsWeb platform. The frontend SPA (newsweb.oslobors.no) serves
 * a React app for all URL paths; the real REST backend (newsapi.oslobors.no) resolves
 * but is not publicly accessible — requests time out from the open internet.
 *
 * To enable: add Puppeteer-based automation or run from a network that can reach
 * newsapi.oslobors.no. Alternatively obtain a direct data feed from Euronext.
 *
 * Fields (when accessible): messageId, time, issuer, issuerFullName, attachment PDF
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors Norway';
const RETENTION_DAYS = 14;
const CURRENCY       = 'NOK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function fetchMessages(from, to) {
  return new Promise((resolve) => {
    const path = `/api/message?issuer=&messageType=INSI&from=${from}&to=${to}&market=&start=0`;
    const req = https.get({
      hostname: 'newsweb.oslobors.no',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://newsweb.oslobors.no/',
        'Origin': 'https://newsweb.oslobors.no',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (!ct.includes('json')) return resolve(null); // HTML shell returned
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeNO() {
  console.log('🇳🇴  Oslo Bors Norway — INSI (insider transactions)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await fetchMessages(from, to);
  if (!data) {
    console.log('  ⚠  Oslo Bors NewsWeb API not accessible (SPA or firewalled backend — needs VPS/Puppeteer).');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const messages = Array.isArray(data) ? data : (data.messages || data.data || []);
  if (!messages.length) { console.log('  No INSI messages in window.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];

  for (const m of messages) {
    const txIso = (m.time || m.publishedTime || '').slice(0, 10) || isoDate(new Date());
    const fid   = `NO-${m.messageId || m.id || (m.issuer + '-' + txIso)}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           m.issuer || null,
      company:          m.issuerFullName || m.issuer || null,
      insider_name:     null,
      insider_role:     null,
      transaction_type: 'UNKNOWN',   // only in attached PDF
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
