/**
 * FR — Insider Transactions Scraper
 *
 * Source: AMF France — BDIF (Base de Données Informations Financières)
 * URL: https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants
 *
 * The AMF BDIF register is a Struts2 server-rendered SPA. HTTP requests return
 * HTTP 500 — the server requires a full browser session with JS to initialise.
 *
 * Table columns (when accessible):
 *   date, émetteur, ISIN, déclarant, qualité, nature, quantité, prix, montant, devise
 *
 * To enable: add Puppeteer/Playwright automation. The search form POSTs to a
 * Struts2 action that returns JSON — intercept that request with a browser.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'FR';
const SOURCE         = 'AMF France';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// Attempt the AMF BDIF API — returns 500 without a valid browser session
function tryAmfApi(from, to) {
  return new Promise((resolve) => {
    const qs = `dateDebut=${from}&dateFin=${to}&type=all&page=0&size=100`;
    const req = https.get({
      hostname: 'bdif.amf-france.org',
      path: `/api/transactions-dirigeants?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants',
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

async function scrapeFR() {
  console.log('🇫🇷  AMF France — BDIF transactions dirigeants');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryAmfApi(from, to);
  if (!data) {
    console.log('  ⚠  AMF BDIF API requires a browser session (HTTP 500 or non-JSON response).');
    console.log('  ℹ  Portal: https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants');
    console.log('  ℹ  To enable: implement Puppeteer headless automation.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.content || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.date || r.dateTransaction || '').slice(0, 10) || from;
    const fid   = `FR-${r.id || r.isin + '-' + txIso + '-' + (r.declarant||'').slice(0,6)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const n = (r.nature || r.typeOperation || '').toLowerCase();
      if (n.includes('acqui') || n.includes('souscri') || n.includes('achat')) return 'BUY';
      if (n.includes('cessi') || n.includes('vente') || n.includes('dispos')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || null,
      company:          r.emetteur || r.issuerName || null,
      insider_name:     r.declarant || null,
      insider_role:     r.qualite || r.fonction || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           r.quantite != null ? Math.round(Math.abs(Number(r.quantite))) : null,
      price_per_share:  r.prix != null ? Number(r.prix) : null,
      total_value:      r.montant != null ? Math.round(Math.abs(Number(r.montant))) : null,
      currency:         r.devise || CURRENCY,
      filing_url:       `https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeFR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
