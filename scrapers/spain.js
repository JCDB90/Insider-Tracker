/**
 * ES — Insider Transactions Scraper
 *
 * Source: CNMV Spain — Portal de la Comisión Nacional del Mercado de Valores
 * URL: https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx
 * API: /ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR  (POST, ASP.NET)
 *
 * The CNMV portal uses ASP.NET with __VIEWSTATE. The MAR insider transactions
 * portal redirects requests without a valid ViewState to an error page (CVFE).
 * The portal appears to have moved — direct URL access results in redirects to
 * /Portal/Error.aspx?errorcode=CVFE.
 *
 * To enable: obtain valid __VIEWSTATE + __EVENTVALIDATION tokens via Puppeteer,
 * then POST form data to the search endpoint.
 *
 * Fields: fecha, emisor, ISIN, declarante, cargo, tipo, número, precio, importe
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function tryGetAPI(from, to) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      FechaDesde: from, FechaHasta: to, Pagina: 1, NumFilas: 100,
    });
    const req = https.request({
      hostname: 'www.cnmv.es',
      path: '/ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': 'https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx',
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
    req.write(body);
    req.end();
  });
}

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain — MAR insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await tryGetAPI(from, to);
  if (!data) {
    console.log('  ⚠  CNMV portal requires ASP.NET ViewState session (portal blocked without browser).');
    console.log('  ℹ  Portal: https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx');
    console.log('  ℹ  To enable: implement Puppeteer to obtain ViewState and POST form.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.Datos || data.data || data.results || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.Fecha || r.fecha || '').slice(0, 10) || from;
    const shares = r.NumAcciones != null ? Math.round(Math.abs(Number(r.NumAcciones))) : null;
    const price  = r.Precio != null ? Number(r.Precio) : null;
    const total  = r.Importe != null ? Math.round(Math.abs(Number(r.Importe))) : (shares && price ? Math.round(shares * price) : null);
    const fid    = `ES-${r.Id || r.ISIN + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.TipoOperacion || r.Tipo || '').toLowerCase();
      if (t.includes('acqui') || t.includes('compra') || t.includes('suscri')) return 'BUY';
      if (t.includes('transmis') || t.includes('venta') || t.includes('dispos')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.ISIN || null,
      company:          r.Emisor || r.NombreEmisor || null,
      insider_name:     r.Declarante || r.NombreDeclarante || null,
      insider_role:     r.Cargo || r.Funcion || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.Divisa || CURRENCY,
      filing_url:       `https://www.cnmv.es/portal/Consultas/MAR/ListaOperaciones.aspx`,
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

scrapeES().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
