/**
 * ES — Insider Transactions Scraper
 *
 * Source: CNMV Spain — Portal de la Comisión Nacional del Mercado de Valores
 * URL: https://www.cnmv.es/Portal/MAR/Operaciones-Directivos
 *
 * ── Geo-restriction ───────────────────────────────────────────────────────────
 * CNMV's WAF (CVFE) blocks non-EU IPs at the network layer — no stealth plugin
 * can bypass an IP geo-block. This scraper works on EU IPs (Hetzner VPS,
 * GitHub Actions EU runners) but NOT from non-EU networks.
 *
 * ── Bot protection ────────────────────────────────────────────────────────────
 * CNMV runs Radware Bot Manager (same as CONSOB Italy). Plain Puppeteer is
 * fingerprinted and blocked. puppeteer-extra + stealth plugin bypasses this.
 *
 * ── Strategy ─────────────────────────────────────────────────────────────────
 * Phase 1 (Puppeteer stealth — preferred):
 *   1. Launch Chromium via puppeteer-extra + stealth plugin.
 *   2. Set Spanish locale headers (es-ES).
 *   3. Intercept all JSON responses from cnmv.es via page.on('response').
 *   4. Navigate to MAR Operaciones-Directivos page.
 *   5. If no data auto-loaded, try in-page fetch to known API endpoints.
 *   6. 2-second delay after navigation before declaring failure.
 *
 * Phase 2 (direct HTTP — fallback for EU IPs where bot check is lighter):
 *   GET portal page → extract session cookie → POST known API endpoints.
 *
 * Fields: Fecha, Emisor, ISIN, Declarante, Cargo, TipoOperacion, NumAcciones,
 *         Precio, Importe, Divisa
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';
const CNMV_HOST      = 'www.cnmv.es';
const MAR_PAGE       = '/Portal/MAR/Operaciones-Directivos';

// Known CNMV API endpoints to try (ordered by likelihood)
const API_ENDPOINTS = [
  '/Portal/MAR/Operaciones-Directivos/GetOperaciones',
  '/Portal/MAR/Operaciones-Directivos/BuscarOperaciones',
  '/Portal/MAR/Operaciones-Directivos/ObtenerListaOperaciones',
  '/Portal/MAR/GetOperaciones',
  '/portal/Consultas/MAR/ListaOperaciones.aspx/GetOperaciones',
  '/portal/Consultas/MAR/ListaOperaciones.aspx/Search',
  '/ServiciosPublicacion/ServicioGratuito/GetNotificacionesInsidersMAR',
];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  if (!Array.isArray(items) || !items.length) return [];

  const seen   = new Set();
  const rows   = [];

  for (const r of items) {
    const rawDate = r.Fecha || r.fecha || r.FechaOperacion || r.FechaDeclaracion || '';
    const txIso   = rawDate.slice(0, 10) || from;
    if (txIso < from) continue;

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
      ticker:           r.ISIN || r.Isin || null,
      company:          r.Emisor       || r.NombreEmisor  || r.RazonSocial    || null,
      insider_name:     r.Declarante   || r.NombreDeclarante                  || null,
      insider_role:     translateRole(r.Cargo || r.Funcion || r.Puesto)       || null,
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

// ─── Phase 1: Puppeteer stealth (mirrors Italy approach) ─────────────────────

async function scrapeViaStealth(from, to) {
  console.log('  Phase 1: puppeteer-extra + stealth…');

  let puppeteer, StealthPlugin;
  try {
    puppeteer    = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    console.log('  ⚠  puppeteer-extra / stealth not installed. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    return null;
  }

  // puppeteer-extra doesn't auto-find bundled Chromium — pass path explicitly
  let executablePath;
  try { executablePath = require('puppeteer').executablePath(); } catch { executablePath = undefined; }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=es-ES',
    ],
  }).catch(err => { console.log(`  ⚠  Browser launch failed: ${err.message}`); return null; });

  if (!browser) return null;

  let apiData = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    // Intercept all JSON responses from CNMV
    const capturedPayloads = [];
    page.on('response', async res => {
      const url = res.url();
      if (!url.includes('cnmv.es')) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const text = await res.text().catch(() => '');
        if (!text) return;
        const json = JSON.parse(text);
        capturedPayloads.push(json);
      } catch { /* non-JSON */ }
    });

    // Navigate — geo-block check
    console.log(`  Loading ${MAR_PAGE} via stealth…`);
    let navOk = false;
    try {
      await page.goto(`https://${CNMV_HOST}${MAR_PAGE}`, { waitUntil: 'networkidle2', timeout: 60000 });
      navOk = true;
    } catch {
      // networkidle2 timeout is OK if data was already captured
      navOk = true;
    }

    const currentUrl = page.url();
    const title      = await page.title().catch(() => '');

    if (currentUrl.includes('CVFE') || title.toLowerCase().includes('acceso restringido') || title.toLowerCase().includes('error')) {
      console.log(`  ⚠  CNMV geo-restricted (URL: ${currentUrl}, title: "${title}").`);
      console.log('  ℹ  Works from EU IPs (Hetzner VPS, GitHub Actions EU runners).');
      await browser.close();
      return null;
    }

    console.log(`  ✓ Page loaded: "${title}" (${capturedPayloads.length} JSON payloads intercepted)`);

    // Wait 2 seconds for any deferred API calls to complete
    await sleep(2000);

    // Check if any captured payload has transaction data
    for (const data of capturedPayloads) {
      const rows = extractRows(data, from);
      if (rows.length > 0) {
        console.log(`  ✓ Intercepted ${rows.length} transactions from API response`);
        apiData = data;
        break;
      }
    }

    // If nothing captured, try in-page fetch to known API endpoints
    if (!apiData) {
      console.log('  No data in intercepted responses — trying in-page fetch to known endpoints…');

      for (const endpoint of API_ENDPOINTS) {
        const payloads = [
          { FechaDesde: from, FechaHasta: to, Pagina: 1, NumFilas: 200 },
          { fechaDesde: from, fechaHasta: to, pagina: 1, numFilas: 200 },
          { desde: from, hasta: to, pagina: 1, numFilas: 200 },
        ];

        for (const payload of payloads) {
          const result = await page.evaluate(async (endpoint, payload) => {
            try {
              const r = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Accept': 'application/json, text/javascript, */*; q=0.01',
                  'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify(payload),
              });
              if (!r.ok) return null;
              return await r.json();
            } catch { return null; }
          }, endpoint, payload).catch(() => null);

          if (result) {
            const rows = extractRows(result, from);
            if (rows.length > 0) {
              console.log(`  ✓ In-page fetch: ${rows.length} rows from ${endpoint}`);
              apiData = result;
              break;
            }
          }
        }
        if (apiData) break;
        await sleep(500);
      }
    }

  } finally {
    await browser.close().catch(() => {});
  }

  return apiData;
}

// ─── Phase 2: Direct HTTP (fallback for EU IPs where bot check is lighter) ───

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

function httpPost(path, body, cookieStr) {
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
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieStr || '',
        'Referer': `https://${CNMV_HOST}${MAR_PAGE}`,
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

async function scrapeViaHttp(from, to) {
  console.log('  Phase 2: Direct HTTP (EU IP fallback)…');

  const pageRes = await httpGet(MAR_PAGE);
  if (!pageRes) { console.log('  ⚠  CNMV unreachable.'); return null; }
  if (pageRes.status === 302 || (pageRes.body || '').includes('CVFE')) {
    console.log('  ⚠  CNMV geo-restricted (CVFE). Needs EU IP.'); return null;
  }
  if (pageRes.status !== 200 || !pageRes.body || pageRes.body.length < 1000) {
    console.log(`  ⚠  Unexpected response: HTTP ${pageRes.status}`); return null;
  }

  const cookieStr = pageRes.cookies;
  console.log(`  ✓ Portal loaded (${pageRes.body.length} bytes)`);

  const payloadTemplates = [
    (f, t) => JSON.stringify({ FechaDesde: f, FechaHasta: t, Pagina: 1, NumFilas: 200 }),
    (f, t) => JSON.stringify({ fechaDesde: f, fechaHasta: t, pagina: 1, numFilas: 200 }),
    (f, t) => JSON.stringify({ desde: f, hasta: t, pagina: 1, numFilas: 200 }),
  ];

  for (const endpoint of API_ENDPOINTS) {
    for (const tmpl of payloadTemplates) {
      const result = await httpPost(endpoint, tmpl(from, to), cookieStr);
      if (result && extractRows(result, from).length > 0) {
        console.log(`  ✓ HTTP: data from ${endpoint}`);
        return result;
      }
    }
    await sleep(300);
  }

  console.log('  ⚠  No working endpoint found via HTTP.');
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain — MAR insider transactions (stealth browser)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // Phase 1: Puppeteer stealth
  let data = await scrapeViaStealth(from, to);

  // Phase 2: Direct HTTP fallback
  if (!data) data = await scrapeViaHttp(from, to);

  if (!data) {
    console.log('  ⚠  CNMV did not return usable data.');
    console.log('  ℹ  Portal: https://www.cnmv.es/Portal/MAR/Operaciones-Directivos');
    console.log('  ℹ  Requires EU IP (Hetzner VPS, GitHub Actions EU runners).');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const rows = extractRows(data, from);
  if (!rows.length) {
    console.log('  No BUY/SELL transactions in retention window.');
    return { saved: 0 };
  }

  // Preview
  for (const r of rows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} shares @ ${r.price_per_share} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(rows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = rows.filter(r => r.transaction_type === 'BUY').length;
  const sells = rows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${rows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: rows.length };
}

scrapeES().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
