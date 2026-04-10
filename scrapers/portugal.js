/**
 * PT — Insider Transactions Scraper
 *
 * Source: CMVM Portugal — Comissão do Mercado de Valores Mobiliários
 * URL: https://www.cmvm.pt/
 *
 * All CMVM portal paths tested redirect to a 404 handler
 * (https://www.cmvm.pt/PInstitucional/CustomHandlers/notfound.aspx).
 * The SDI (Sistema de Difusão de Informação) endpoint at
 * /pt/SDI/Emitentes/pages/PesquisaDeInsiders.aspx has been removed.
 *
 * Portuguese insider transactions (operações de pessoas com responsabilidades
 * de gestão) are published under MAR Article 19 requirements.
 *
 * To enable: find the new CMVM SDI portal URL (may have moved to a new domain)
 * or implement Puppeteer to navigate the new portal.
 * Try checking: https://www.cmvm.pt/pt/ for the current navigation structure.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'PT';
const SOURCE         = 'CMVM Portugal';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('compra') || l.includes('subscrição')) return 'BUY';
  if (l.includes('aliena') || l.includes('venda') || l.includes('disposi')) return 'SELL';
  return 'OTHER';
}

function tryCmvmApi(from, to) {
  return new Promise((resolve) => {
    const qs = `dateFrom=${from}&dateTo=${to}&page=1&pageSize=100&format=json`;
    const req = https.get({
      hostname: 'www.cmvm.pt',
      path: `/pt/SDI/Emitentes/api/insider-transactions?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.cmvm.pt/',
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

async function scrapePT() {
  console.log('🇵🇹  CMVM Portugal — operações de pessoas com responsabilidades de gestão');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryCmvmApi(from, to);
  if (!data) {
    console.log('  ⚠  CMVM portal not accessible (SDI endpoint removed/relocated — all paths 404).');
    console.log('  ℹ  Portal: https://www.cmvm.pt/pt/');
    console.log('  ℹ  To enable: locate the current CMVM insider transactions search URL.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.operacoes || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso  = (r.data || r.dataOperacao || '').slice(0, 10) || from;
    const shares = r.quantidade != null ? Math.round(Math.abs(Number(r.quantidade))) : null;
    const price  = r.preco != null ? Number(r.preco) : null;
    const total  = r.montante != null ? Math.round(Math.abs(Number(r.montante))) : (shares && price ? Math.round(shares * price) : null);
    const fid    = `PT-${r.id || r.isin + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin || null,
      company:          r.emitente || r.nomeEmitente || null,
      insider_name:     r.declarante || r.nomePessoa || null,
      insider_role:     translateRole(r.cargo || r.funcao) || null,
      transaction_type: mapType(r.tipoOperacao || r.natureza || ''),
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.moeda || CURRENCY,
      filing_url:       `https://www.cmvm.pt/pt/`,
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

scrapePT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
