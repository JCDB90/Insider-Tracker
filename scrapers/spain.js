/**
 * ES — Insider Transactions Scraper
 *
 * Source: CNMV Spain — Portal de la Comisión Nacional del Mercado de Valores
 * URL: https://www.cnmv.es/Portal/MAR/Operaciones-Directivos
 *
 * The CNMV MAR portal is geo-restricted to EU IPs. It works from GitHub Actions
 * (Azure EU runners) but not from other regions.
 *
 * Approach (2-step):
 *   1. GET the page to capture ASP.NET session cookies and the AJAX endpoint
 *      from inline JavaScript (looks for API URL patterns in the page source).
 *   2. POST to the discovered API endpoint with date range + session cookie.
 *
 * The old endpoint (/ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR)
 * returned 404. The new endpoint is discovered from the page's JavaScript.
 *
 * If geo-blocked (CVFE error) or endpoint not discovered, exits gracefully.
 *
 * Fields: fecha, emisor, ISIN, declarante, cargo, tipo, número, precio, importe
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function get(path, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'www.cnmv.es',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        cookies: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

function post(path, body, cookieStr, extraHeaders = {}) {
  return new Promise((resolve) => {
    const data = Buffer.from(body);
    const req = https.request({
      hostname: 'www.cnmv.es',
      path,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieStr,
        'Referer': 'https://www.cnmv.es/Portal/MAR/Operaciones-Directivos',
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        const ct = res.headers['content-type'] || '';
        if (!ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function extractCookieStr(setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return '';
  return setCookieHeaders
    .map(c => c.split(';')[0])
    .join('; ');
}

function findApiEndpoint(html) {
  // Look for AJAX URL patterns in page JavaScript
  const patterns = [
    /url\s*:\s*["']([^"']*(?:GetOperaciones|GetMAR|ListaOperaciones|GetTransacciones|MAR)[^"']*)["']/i,
    /["']([^"']*\/Portal\/MAR\/[^"']*(?:Get|Search|List)[^"']*)["']/i,
    /["']([^"']*\/ServiciosPublicacion\/[^"']+)["']/i,
    /["']([^"']*GetNotificaciones[^"']*)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain — MAR insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // Step 1: GET the MAR page to get session cookie + discover API endpoint
  const pagePaths = [
    '/Portal/MAR/Operaciones-Directivos',
    '/portal/Consultas/MAR/ListaOperaciones.aspx',
  ];

  let pageHtml = null;
  let cookieStr = '';

  for (const pagePath of pagePaths) {
    const res = await get(pagePath);
    if (!res) continue;

    // Geo-block check
    if (res.status === 403 || (res.body || '').includes('errorcode=CVFE') || (res.body || '').includes('CVFE')) {
      console.log('  ⚠  CNMV portal is geo-restricted to EU IPs (CVFE error).');
      console.log('  ℹ  This scraper works on GitHub Actions EU runners but not from all networks.');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }

    if (res.status === 200 && res.body && res.body.length > 1000) {
      pageHtml = res.body;
      cookieStr = extractCookieStr(res.cookies);
      console.log(`  ✓ Got page (${res.body.length} bytes), cookie: ${cookieStr ? 'yes' : 'no'}`);
      break;
    }
  }

  if (!pageHtml) {
    console.log('  ⚠  CNMV MAR page not accessible (network issue or geo-block).');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  // Step 2: Find API endpoint from page JavaScript
  const discoveredEndpoint = findApiEndpoint(pageHtml);

  // Known endpoints to try (in order)
  const endpoints = [
    ...(discoveredEndpoint ? [discoveredEndpoint] : []),
    '/Portal/MAR/Operaciones-Directivos/GetOperaciones',
    '/Portal/MAR/GetOperaciones',
    '/portal/Consultas/MAR/ListaOperaciones.aspx/GetOperaciones',
    '/portal/Consultas/MAR/ListaOperaciones.aspx/Search',
    '/ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR',
  ];

  const bodyPayload = JSON.stringify({
    FechaDesde: from, FechaHasta: to, Pagina: 1, NumFilas: 100,
  });

  let data = null;
  for (const endpoint of endpoints) {
    console.log(`  Trying: ${endpoint}`);
    const result = await post(endpoint, bodyPayload, cookieStr);
    if (result) {
      data = result;
      console.log(`  ✓ API responded`);
      break;
    }
  }

  if (!data) {
    console.log('  ⚠  CNMV MAR API endpoint not found or not accessible.');
    console.log('  ℹ  The page loaded but no working JSON API was found.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.Datos || data.data || data.results || data.Items || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of items) {
    const txIso = (r.Fecha || r.fecha || r.FechaOperacion || '').slice(0, 10) || from;
    const shares = r.NumAcciones != null ? Math.round(Math.abs(Number(r.NumAcciones))) : null;
    const price  = r.Precio != null ? Number(r.Precio) : null;
    const total  = r.Importe != null ? Math.round(Math.abs(Number(r.Importe))) : (shares && price ? Math.round(shares * price) : null);
    const fid    = `ES-${r.Id || r.ISIN + '-' + txIso + '-' + String(shares||0)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const txType = (() => {
      const t = (r.TipoOperacion || r.Tipo || r.tipo || '').toLowerCase();
      if (t.includes('acqui') || t.includes('compra') || t.includes('suscri')) return 'BUY';
      if (t.includes('transmis') || t.includes('venta') || t.includes('dispos')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.ISIN || '',
      company:          r.Emisor || r.NombreEmisor || null,
      insider_name:     r.Declarante || r.NombreDeclarante || null,
      insider_role:     translateRole(r.Cargo || r.Funcion) || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.Divisa || CURRENCY,
      filing_url:       `https://www.cnmv.es/Portal/MAR/Operaciones-Directivos`,
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
