/**
 * ES — Insider Transactions Scraper
 *
 * Source: CNMV Spain — Portal de la Comisión Nacional del Mercado de Valores
 * URL: https://www.cnmv.es/Portal/MAR/Operaciones-Directivos
 *
 * ── Geo-restriction ───────────────────────────────────────────────────────────
 * The CNMV MAR portal is geo-restricted to EU IPs by a CDN/WAF rule (CVFE error).
 * This scraper works on GitHub Actions EU runners but NOT from non-EU networks.
 * Puppeteer does NOT bypass this — the restriction is IP-based.
 *
 * ── Strategy ─────────────────────────────────────────────────────────────────
 * Phase 1 (Puppeteer — preferred):
 *   1. Launch headless Chromium.
 *   2. Intercept all JSON responses from www.cnmv.es.
 *   3. Navigate to the MAR Operaciones-Directivos page.
 *   4. Wait for the page to load (networkidle2) and capture API responses.
 *   5. If the page auto-loads the last N days, use that data.
 *      If it needs form interaction, fill dates and click search.
 *
 * Phase 2 (direct HTTP — fallback when Puppeteer fails to capture data):
 *   1. GET the MAR portal page to obtain session cookies.
 *   2. Discover the API endpoint from inline JavaScript (URL patterns).
 *   3. POST to the discovered endpoint with date-range parameters.
 *
 * Fields: Fecha, Emisor, ISIN, Declarante, Cargo, TipoOperacion, NumAcciones,
 *         Precio, Importe, Divisa
 */
'use strict';

const https     = require('https');
const puppeteer = require('puppeteer');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';
const CNMV_HOST      = 'www.cnmv.es';
const MAR_PAGE       = '/Portal/MAR/Operaciones-Directivos';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function mapTxType(raw) {
  const t = (raw || '').toLowerCase();
  if (t.includes('acqui') || t.includes('compra') || t.includes('suscri') || t.includes('adquisi')) return 'BUY';
  if (t.includes('transmis') || t.includes('venta') || t.includes('dispos') || t.includes('enajena')) return 'SELL';
  return 'OTHER';
}

// ─── Extract rows from CNMV API payload ──────────────────────────────────────

function extractRows(data, from) {
  if (!data) return [];
  const items =
    data.Datos   || data.datos   ||
    data.Items   || data.items   ||
    data.data    || data.results ||
    data.Records || data.records ||
    (Array.isArray(data) ? data : []);
  if (!Array.isArray(items)) return [];

  const seen   = new Set();
  const rows   = [];
  const cutStr = from;

  for (const r of items) {
    const rawDate = r.Fecha || r.fecha || r.FechaOperacion || r.FechaDeclaracion || '';
    const txIso   = rawDate.slice(0, 10) || from;
    if (txIso < cutStr) continue;

    const shares = r.NumAcciones != null ? Math.round(Math.abs(Number(r.NumAcciones))) : null;
    const price  = r.Precio      != null ? Number(r.Precio)                            : null;
    const total  = r.Importe     != null ? Math.round(Math.abs(Number(r.Importe)))
                 : (shares && price ? Math.round(shares * price) : null);

    const fid = `ES-${r.Id || r.Identificador || (String(r.ISIN || '')+'-'+txIso+'-'+String(shares||''))}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    rows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.ISIN || r.Isin || '',
      company:          r.Emisor          || r.NombreEmisor    || r.RazonSocial   || null,
      insider_name:     r.Declarante      || r.NombreDeclarante                   || null,
      insider_role:     translateRole(r.Cargo || r.Funcion || r.Puesto)           || null,
      transaction_type: mapTxType(r.TipoOperacion || r.Tipo || r.tipo),
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.Divisa || r.Moneda || CURRENCY,
      filing_url:       `https://${CNMV_HOST}${MAR_PAGE}`,
      source:           SOURCE,
    });
  }
  return rows;
}

// ─── Phase 1: Puppeteer ───────────────────────────────────────────────────────

async function scrapeViaPuppeteer(from, to) {
  console.log('  Phase 1: Puppeteer (intercepts CNMV API responses)…');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    timeout: 30000,
  }).catch(() => null);

  if (!browser) {
    console.log('  ⚠  Puppeteer browser failed to launch.');
    return null;
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Capture every JSON response from CNMV
    const capturedPayloads = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('cnmv.es')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('javascript')) return;
      try {
        const text = await response.text().catch(() => '');
        if (!text || !text.trim().startsWith('{') && !text.trim().startsWith('[')) return;
        const data = JSON.parse(text);
        capturedPayloads.push({ url, data });
      } catch { /* non-JSON or parse error */ }
    });

    // Navigate — geo-block check
    const navResponse = await page.goto(`https://${CNMV_HOST}${MAR_PAGE}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    }).catch(() => null);

    const currentUrl = page.url();
    const title      = await page.title().catch(() => '');

    if (!navResponse || currentUrl.includes('CVFE') || title.toLowerCase().includes('error')) {
      console.log(`  ⚠  CNMV portal geo-restricted (title: "${title}").`);
      console.log('  ℹ  This scraper works from GitHub Actions EU runners.');
      await browser.close();
      return null;
    }

    console.log(`  ✓ Page loaded: "${title}" (${capturedPayloads.length} JSON responses so far)`);

    // If the page didn't auto-load data, try interacting with the search form
    if (!capturedPayloads.some(p => p.data.Datos || p.data.datos || Array.isArray(p.data))) {
      console.log('  No data-bearing response yet — trying form interaction…');

      // Try to find and fill date inputs
      try {
        await page.evaluate((from, to) => {
          const inputs = document.querySelectorAll('input[type="date"], input[id*="fecha"], input[id*="Fecha"], input[placeholder*="dd/mm"]');
          const textInputs = [...inputs];
          if (textInputs.length >= 2) {
            // Try setting first two date inputs to from/to
            const [dFrom, dTo] = textInputs;
            // CNMV uses dd/mm/yyyy format in inputs
            const toSpanish = iso => iso.split('-').reverse().join('/');
            const nativeInput = (el, val) => {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            };
            nativeInput(dFrom, toSpanish(from));
            nativeInput(dTo,   toSpanish(to));
          }
        }, from, to);

        // Click search button
        const searchBtn = await page.$('button[type="submit"], input[type="submit"], .btn-buscar, .btn-search, button:contains("Buscar"), button:contains("Search")');
        if (searchBtn) {
          await searchBtn.click();
          await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => {});
        }
      } catch { /* ignore interaction errors */ }
    }

    // Scan captured payloads for transaction data
    let bestPayload = null;
    for (const { data } of capturedPayloads) {
      const items =
        data.Datos   || data.datos   ||
        data.Items   || data.items   ||
        data.data    || data.results ||
        (Array.isArray(data) ? data : null);
      if (Array.isArray(items) && items.length > 0) {
        if (!bestPayload || items.length > (bestPayload.Datos || bestPayload.items || []).length) {
          bestPayload = data;
        }
      }
    }

    await browser.close();

    if (!bestPayload) {
      console.log(`  ⚠  Page loaded but no transaction data found in ${capturedPayloads.length} intercepted responses.`);
      return null;
    }

    console.log('  ✓ Transaction data captured from API response');
    return bestPayload;

  } catch (err) {
    console.log(`  ⚠  Puppeteer error: ${err.message}`);
    await browser.close().catch(() => {});
    return null;
  }
}

// ─── Phase 2: Direct HTTP ─────────────────────────────────────────────────────

function httpGet(path, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: CNMV_HOST,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
        cookies: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
      }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

function httpPost(path, body, cookieStr, extraHeaders = {}) {
  return new Promise((resolve) => {
    const data = Buffer.from(body);
    const req = https.request({
      hostname: CNMV_HOST,
      path,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieStr,
        'Referer': `https://${CNMV_HOST}${MAR_PAGE}`,
        ...extraHeaders,
        'Content-Length': data.length,
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

function findApiEndpoint(html) {
  const patterns = [
    /url\s*:\s*["']([^"']*(?:GetOperaciones|BuscarOperaciones|GetMAR|ListaOperaciones|GetTransacciones|MAR)[^"']*)["']/i,
    /["']([^"']*\/Portal\/MAR\/[^"']*(?:Get|Search|List|Buscar)[^"']*)["']/i,
    /["']([^"']*\/ServiciosPublicacion\/[^"']+)["']/i,
    /["']([^"']*GetNotificaciones[^"']*)["']/i,
    /["']([^"']*\/api\/[^"']*(?:mar|insider|operacion)[^"']*)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1]) return m[1].startsWith('/') ? m[1] : '/' + m[1];
  }
  return null;
}

async function scrapeViaHttp(from, to) {
  console.log('  Phase 2: Direct HTTP (requires EU IP with CNMV session)…');

  // Load portal page to get session cookie
  const pageRes = await httpGet(MAR_PAGE);
  if (!pageRes) {
    console.log('  ⚠  CNMV portal unreachable (network error).');
    return null;
  }
  if (pageRes.status === 302 || (pageRes.body || '').includes('errorcode=CVFE') || (pageRes.body || '').includes('CVFE')) {
    console.log('  ⚠  CNMV portal geo-restricted to EU IPs (CVFE error).');
    console.log('  ℹ  Runs on GitHub Actions EU runners. 0 rows saved.');
    return null;
  }
  if (pageRes.status !== 200 || !pageRes.body || pageRes.body.length < 1000) {
    console.log(`  ⚠  Unexpected portal response: ${pageRes.status}`);
    return null;
  }

  const cookieStr = pageRes.cookies;
  console.log(`  ✓ Portal page loaded (${pageRes.body.length} bytes, cookie: ${cookieStr ? 'yes' : 'no'})`);

  // Discover or fall back to known endpoints
  const discovered = findApiEndpoint(pageRes.body);
  const endpoints = [
    ...(discovered ? [discovered] : []),
    '/Portal/MAR/Operaciones-Directivos/GetOperaciones',
    '/Portal/MAR/Operaciones-Directivos/BuscarOperaciones',
    '/Portal/MAR/Operaciones-Directivos/ObtenerListaOperaciones',
    '/Portal/MAR/GetOperaciones',
    '/portal/Consultas/MAR/ListaOperaciones.aspx/GetOperaciones',
    '/portal/Consultas/MAR/ListaOperaciones.aspx/Search',
    '/portal/Consultas/MAR/ListaOperaciones.aspx/ObtenerListaOperaciones',
    '/ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR',
  ];

  // Try different payload formats each endpoint might expect
  const payloads = [
    JSON.stringify({ FechaDesde: from, FechaHasta: to, Pagina: 1, NumFilas: 100 }),
    JSON.stringify({ fechaDesde: from, fechaHasta: to, pagina: 1, numFilas: 100 }),
    JSON.stringify({ desde: from, hasta: to, pagina: 1, numFilas: 100 }),
    JSON.stringify({ dateFrom: from, dateTo: to, page: 1, pageSize: 100 }),
  ];

  for (const endpoint of endpoints) {
    for (const payload of payloads) {
      console.log(`  Trying: ${endpoint}`);
      const result = await httpPost(endpoint, payload, cookieStr);
      if (result) {
        console.log('  ✓ API responded');
        return result;
      }
    }
  }

  console.log('  ⚠  No working CNMV API endpoint found.');
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain — MAR insider transactions');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // Phase 1: Puppeteer
  let data = await scrapeViaPuppeteer(from, to);

  // Phase 2: Direct HTTP fallback
  if (!data) {
    data = await scrapeViaHttp(from, to);
  }

  if (!data) {
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const rows = extractRows(data, from);
  if (!rows.length) {
    console.log('  No transactions found in retention window.');
    return { saved: 0 };
  }

  const { error } = await saveInsiderTransactions(rows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = rows.filter(r => r.transaction_type === 'BUY').length;
  const sells = rows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${rows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: rows.length };
}

scrapeES().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
