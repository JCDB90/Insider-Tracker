/**
 * IT — Insider Transactions Scraper
 *
 * Source: CONSOB Italy — Commissione Nazionale per le Società e la Borsa
 * URL: https://www.consob.it/web/area-pubblica/operazioni-manager
 *
 * CONSOB is protected by Radware Bot Manager — all server-side requests are
 * challenged and redirected to validate.perfdrive.com. The portal requires a
 * real browser session to pass the JS/mouse-tracking challenge.
 *
 * To enable: implement Puppeteer with puppeteer-extra-plugin-stealth.
 *
 * Fields (when accessible):
 *   data, emittente, ISIN, soggetto obbligato, qualifica,
 *   tipo operazione, quantità, prezzo, controvalore, divisa
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'IT';
const SOURCE         = 'CONSOB Italy';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function tryConsobApi(from, to) {
  return new Promise((resolve) => {
    const qs = `dataDa=${from}&dataA=${to}&pagina=1&righePerPagina=100`;
    const req = https.get({
      hostname: 'www.consob.it',
      path: `/web/area-pubblica/operazioni-manager-api?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.consob.it/web/area-pubblica/operazioni-manager',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        // Radware returns 302 to validate.perfdrive.com
        if (res.statusCode === 302 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeIT() {
  console.log('🇮🇹  CONSOB Italy — operazioni soggetti rilevanti MAR');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryConsobApi(from, to);
  if (!data) {
    console.log('  ⚠  CONSOB is protected by Radware Bot Manager (bot challenge required).');
    console.log('  ℹ  Portal: https://www.consob.it/web/area-pubblica/operazioni-manager');
    console.log('  ℹ  To enable: implement Puppeteer + puppeteer-extra-plugin-stealth.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.operazioni || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.data || r.dataOperazione || '').slice(0, 10) || from;
    const shares = r.quantita != null ? Math.round(Math.abs(Number(r.quantita))) : null;
    const price  = r.prezzo != null ? Number(r.prezzo) : null;
    const total  = r.controvalore != null ? Math.round(Math.abs(Number(r.controvalore))) : null;
    const fid    = `IT-${r.id || r.isin + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.tipoOperazione || r.tipo || '').toLowerCase();
      if (t.includes('acquisto') || t.includes('sottoscri') || t.includes('buy')) return 'BUY';
      if (t.includes('vendita') || t.includes('cessione') || t.includes('sell')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || null,
      company:          r.emittente || r.nomeEmittente || null,
      insider_name:     r.soggetto || r.nomeSoggetto || null,
      insider_role:     r.qualifica || r.carica || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.divisa || CURRENCY,
      filing_url:       `https://www.consob.it/web/area-pubblica/operazioni-manager`,
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

scrapeIT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
