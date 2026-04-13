/**
 * IT — Insider Transactions Scraper
 *
 * Source: CONSOB Italy — Commissione Nazionale per le Società e la Borsa
 * URL: https://www.consob.it/web/area-pubblica/operazioni-manager
 *
 * CONSOB is protected by Radware Bot Manager which blocks plain HTTP requests.
 * Strategy: puppeteer-extra + stealth plugin to emulate a real Chrome browser,
 * intercept the AJAX call to /operazioni-manager-api, and parse the JSON.
 *
 * On GitHub Actions (fresh EU Azure IP per run) the first stealth request
 * passes Radware's challenge. Local datacenter IPs may time out.
 *
 * API endpoint (called by the CONSOB SPA):
 *   GET /web/area-pubblica/operazioni-manager-api
 *     ?dataDa=YYYY-MM-DD&dataA=YYYY-MM-DD&pagina=1&righePerPagina=100
 *
 * Response JSON fields (Italian):
 *   data / dataOperazione  → transaction date
 *   emittente              → issuer (company)
 *   isin                   → ISIN
 *   soggetto / nomeSoggetto→ insider name
 *   qualifica / carica     → role
 *   tipoOperazione / tipo  → BUY/SELL (acquisto/vendita)
 *   quantita               → shares
 *   prezzo                 → price per share
 *   controvalore           → total value
 *   divisa                 → currency
 *   id                     → filing ID
 */
'use strict';

const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'IT';
const SOURCE         = 'CONSOB Italy';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── Puppeteer stealth scraper ────────────────────────────────────────────────

async function fetchViaHeadless(from, to) {
  let puppeteer, StealthPlugin;
  try {
    puppeteer    = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    console.log('  ⚠  puppeteer-extra / stealth not installed. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
    return null;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  let apiData = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    // Intercept the CONSOB API response
    const captured = new Promise((resolve) => {
      page.on('response', async res => {
        const url = res.url();
        if (url.includes('operazioni-manager-api')) {
          try {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('json') || res.status() === 200) {
              const text = await res.text();
              try { resolve(JSON.parse(text)); } catch { resolve(null); }
            }
          } catch { resolve(null); }
        }
      });
      // Timeout after 90s
      setTimeout(() => resolve(null), 90000);
    });

    // Navigate to CONSOB with a date range pre-set in the URL
    const url = `https://www.consob.it/web/area-pubblica/operazioni-manager?dataDa=${from}&dataA=${to}`;
    console.log('  Loading CONSOB via headless Chrome (stealth)…');
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    } catch {
      // networkidle2 timeout is OK if data was already captured
    }

    // Wait for the intercept (up to 90s total)
    apiData = await captured;

    // If interception didn't capture, try making the API call from within page context
    if (!apiData) {
      console.log('  No intercepted API call — trying in-page fetch…');
      const result = await page.evaluate(async (from, to) => {
        try {
          const r = await fetch(
            `/web/area-pubblica/operazioni-manager-api?dataDa=${from}&dataA=${to}&pagina=1&righePerPagina=100`,
            { headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }
          );
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      }, from, to).catch(() => null);
      apiData = result;
    }
  } finally {
    await browser.close();
  }

  return apiData;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeIT() {
  console.log('🇮🇹  CONSOB Italy — operazioni soggetti rilevanti MAR (via stealth browser)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const data = await fetchViaHeadless(from, to);

  if (!data) {
    console.log('  ⚠  CONSOB did not return usable data (Radware block or timeout).');
    console.log('  ℹ  Portal: https://www.consob.it/web/area-pubblica/operazioni-manager');
    console.log('  ℹ  This scraper uses puppeteer-extra + stealth; works best on GitHub Actions EU runners.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = data.operazioni || data.data || (Array.isArray(data) ? data : []);
  if (!items.length) { console.log('  No data in response.'); return { saved: 0 }; }
  console.log(`  Received ${items.length} items from CONSOB API`);

  const seen = new Set();
  const dbRows = [];

  for (const r of items) {
    const txIso  = (r.data || r.dataOperazione || '').slice(0, 10) || from;
    const shares = r.quantita    != null ? Math.round(Math.abs(Number(r.quantita)))     : null;
    const price  = r.prezzo      != null ? Number(r.prezzo)                              : null;
    const total  = r.controvalore != null ? Math.round(Math.abs(Number(r.controvalore))) : null;
    const fid    = `IT-${r.id || (r.isin || 'X') + '-' + txIso + '-' + String(shares || 0)}`;

    if (seen.has(fid)) continue;
    seen.add(fid);

    const txType = (() => {
      const t = (r.tipoOperazione || r.tipo || '').toLowerCase();
      if (t.includes('acquisto') || t.includes('sottoscri') || t.includes('buy')) return 'BUY';
      if (t.includes('vendita')  || t.includes('cessione')  || t.includes('sell')) return 'SELL';
      return 'OTHER';
    })();

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           r.isin || null,
      company:          r.emittente || r.nomeEmittente || null,
      insider_name:     r.soggetto  || r.nomeSoggetto  || null,
      insider_role:     translateRole(r.qualifica || r.carica) || null,
      transaction_type: txType,
      transaction_date: txIso || null,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         r.divisa || CURRENCY,
      filing_url:       `https://www.consob.it/web/area-pubblica/operazioni-manager`,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  // Preview
  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} shares @ ${r.price_per_share} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeIT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
