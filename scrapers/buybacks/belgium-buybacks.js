'use strict';
/**
 * BE — Share Buyback Scraper
 *
 * Source: FSMA STORI (Système de Transparence des Informations Réglementées)
 * API:    POST https://webapi.fsma.be/api/v1/en/stori/result
 *
 * Fetches "Announcement of acquisition of own shares" filings
 * (documentTypeId: fd1dc80a-b4a6-4878-acbd-362e00f693c9).
 *
 * SORT NOTE: The STORI result endpoint sorts by company name (A-Z) as primary
 * key, then by date descending within each company. There is no way to sort
 * purely by date across companies using sortDirection alone.
 *
 * APPROACH: Use the companyId filter — one request per Belgian company to get
 * their most recent buyback filing. The company list comes from:
 *   GET https://webapi.fsma.be/api/v1/en/stori/companies/abbreviated-name
 * (~274 companies as of 2026). We keep only companies whose most recent
 * "acquisition of own shares" filing falls within the lookback window.
 *
 * The API requires Chrome-like request headers (sec-fetch-mode, Origin, etc.)
 * to pass the CORS validation layer.
 *
 * Fields: company name, ISIN, LEI, publication date. Execution details
 * (shares bought, price) are inside the PDF — not parsed here.
 */

const https = require('https');
const { saveBuybackPrograms } = require('../lib/db');
const { isinToTicker }        = require('../lib/isinToTicker');

const COUNTRY_CODE     = 'BE';
const SOURCE           = 'FSMA STORI';
const RETENTION_DAYS   = parseInt(process.env.LOOKBACK_DAYS || '90');
// Fetch the 3 most recent filings per company so the frontend can show history
const FILINGS_PER_CO   = 3;
const DELAY_MS         = 200;
const BUYBACK_TYPE_ID  = 'fd1dc80a-b4a6-4878-acbd-362e00f693c9';

const STORI_HOST      = 'webapi.fsma.be';
const COMPANIES_PATH  = '/api/v1/en/stori/companies/abbreviated-name';
const RESULT_PATH     = '/api/v1/en/stori/result';
const STORI_PAGE      = 'https://www.fsma.be/en/stori';

const HEADERS = {
  'Accept':                    'application/json, text/plain, */*',
  'Origin':                    'https://www.fsma.be',
  'Referer':                   'https://www.fsma.be/en/stori',
  'access-control-allow-origin': 'https://www.fsma.be',
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language':           'en-US,en;q=0.9',
  'sec-fetch-mode':            'cors',
  'sec-fetch-site':            'cross-site',
  'sec-fetch-dest':            'empty',
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(path) {
  return new Promise((resolve) => {
    const req = https.get({ hostname: STORI_HOST, path, headers: HEADERS }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

function postJson(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: STORI_HOST,
      path:     RESULT_PATH,
      method:   'POST',
      headers:  { ...HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function scrapeBEBuybacks() {
  console.log('🇧🇪  FSMA STORI — Belgian Share Buybacks (per-company query)');
  const t0         = Date.now();
  const co         = cutoff();
  const cutoffStr  = isoDate(co);
  console.log(`  Lookback: ${RETENTION_DAYS} days (from ${cutoffStr})`);

  // ── Step 1: Get all Belgian companies from STORI ──────────────────────────
  const companyList = await httpsGet(COMPANIES_PATH);
  if (!companyList || !Array.isArray(companyList)) {
    console.error('  ❌ Could not fetch company list'); process.exit(1);
  }
  console.log(`  Scanning ${companyList.length} companies for recent filings…`);

  // ── Step 2: For each company, fetch their most recent buyback filings ──────
  const seen   = new Set();
  const dbRows = [];
  let   hits   = 0;
  let   errors = 0;

  for (let i = 0; i < companyList.length; i++) {
    const company = companyList[i];
    const companyId = company.companyId;
    if (!companyId) continue;

    const data = await postJson({
      startRowIndex:  0,
      pageSize:       FILINGS_PER_CO,
      documentTypeId: BUYBACK_TYPE_ID,
      companyId,
    });

    if (!data) { errors++; await delay(DELAY_MS); continue; }

    const items = data.storiResultItems || [];
    // Keep only filings within the lookback window
    const recent = items.filter(item => (item.datePublication || '').slice(0, 10) >= cutoffStr);
    if (!recent.length) { await delay(DELAY_MS); continue; }

    hits++;
    for (const item of recent) {
      const filingId = `BE-STORI-${item.requiredReportingTopicId}`;
      if (seen.has(filingId)) continue;
      seen.add(filingId);

      const isin = item.isinCodes?.[0]?.code || null;
      const doc  = item.mainDocuments?.find(d => d.language === 'en') || item.mainDocuments?.[0];

      dbRows.push({
        filing_id:      filingId,
        country_code:   COUNTRY_CODE,
        ticker:         '',
        company:        item.companyName || null,
        announced_date: item.datePublication.slice(0, 10),
        execution_date: item.datePublication.slice(0, 10),
        currency:       'EUR',
        status:         'Active',
        filing_url:     STORI_PAGE,
        source_url:     STORI_PAGE,
        source:         SOURCE,
        shares_bought:  null,
        avg_price:      null,
        total_value:    null,
        _isin:          isin,
        _lei:           item.lei || null,
      });
    }

    await delay(DELAY_MS);

    // Progress log every 50 companies
    if ((i + 1) % 50 === 0) {
      console.log(`  … ${i + 1}/${companyList.length} companies checked, ${hits} with recent filings`);
    }
  }

  console.log(`  Scan complete: ${hits} companies with filings in window, ${errors} API errors`);
  if (!dbRows.length) { console.log('  No data.'); return { saved: 0 }; }

  // ── Step 3: Resolve ISIN → ticker ─────────────────────────────────────────
  let resolved = 0;
  for (const r of dbRows) {
    if (r._isin) {
      try {
        const t = await isinToTicker(r._isin);
        if (t) { r.ticker = t; resolved++; }
      } catch {}
    }
    delete r._isin;
    delete r._lei;
  }
  if (resolved > 0) console.log(`  Resolved ${resolved} tickers from ISIN`);

  // ── Step 4: Save ───────────────────────────────────────────────────────────
  const uniqueCompanies = [...new Set(dbRows.map(r => r.company))];
  console.log(`  Unique companies: ${uniqueCompanies.length}`);
  console.log(`  Companies: ${uniqueCompanies.slice(0, 10).join(', ')}${uniqueCompanies.length > 10 ? '…' : ''}`);

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} filings saved (${uniqueCompanies.length} companies)`);
  return { saved: dbRows.length };
}

scrapeBEBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
