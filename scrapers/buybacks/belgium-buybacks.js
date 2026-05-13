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
 * The API does not support server-side date filtering; we paginate descending
 * by datePublication and stop once results fall outside our lookback window.
 *
 * The API requires Chrome-like request headers to pass CORS validation —
 * specifically `sec-fetch-mode: cors` and a matching Origin/access-control-allow-origin.
 *
 * Fields available per filing: company name, ISIN, LEI, publication date,
 * PDF document metadata (fileDataId). Execution details (shares, price) are
 * inside the PDF and are not parsed here.
 */

const https = require('https');
const { saveBuybackPrograms } = require('../lib/db');
const { isinToTicker }        = require('../lib/isinToTicker');

const COUNTRY_CODE     = 'BE';
const SOURCE           = 'FSMA STORI';
const RETENTION_DAYS   = parseInt(process.env.LOOKBACK_DAYS || '365');
const PAGE_SIZE        = 50;
const DELAY_MS         = 300;
const BUYBACK_TYPE_ID  = 'fd1dc80a-b4a6-4878-acbd-362e00f693c9';

const STORI_HOST = 'webapi.fsma.be';
const STORI_PATH = '/api/v1/en/stori/result';
const STORI_PAGE = 'https://www.fsma.be/en/stori';

const HEADERS = {
  'Content-Type':              'application/json',
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

function postJson(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: STORI_HOST,
      path:     STORI_PATH,
      method:   'POST',
      headers:  { ...HEADERS, 'Content-Length': Buffer.byteLength(payload) },
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
  console.log('🇧🇪  FSMA STORI — Belgian Share Buybacks (acquisition of own shares)');
  const t0  = Date.now();
  const co  = cutoff();
  const cutoffStr = isoDate(co);
  console.log(`  Lookback: ${RETENTION_DAYS} days (from ${cutoffStr})`);

  const seen   = new Set();
  const dbRows = [];
  let   start  = 0;
  let   total  = null;
  let   pages  = 0;

  while (true) {
    const data = await postJson({
      startRowIndex:  start,
      pageSize:       PAGE_SIZE,
      sortDirection:  'Descending',
      documentTypeId: BUYBACK_TYPE_ID,
    });

    if (!data) {
      console.warn(`  ⚠  API error at startRowIndex=${start}`);
      break;
    }

    if (total === null) {
      total = data.resultCount || 0;
      console.log(`  Total filings in STORI: ${total}`);
    }

    const items = data.storiResultItems || [];
    if (!items.length) break;
    pages++;

    let cutoffReached = false;
    for (const item of items) {
      const pubDate = (item.datePublication || '').slice(0, 10);
      if (pubDate < cutoffStr) { cutoffReached = true; break; }

      const filingId = `BE-STORI-${item.requiredReportingTopicId}`;
      if (seen.has(filingId)) continue;
      seen.add(filingId);

      const isin    = item.isinCodes?.[0]?.code || null;
      const market  = item.isinCodes?.[0]?.market || null;
      const doc     = item.mainDocuments?.find(d => d.language === 'en') || item.mainDocuments?.[0];
      const fileId  = doc?.fileDataId || null;

      dbRows.push({
        filing_id:      filingId,
        country_code:   COUNTRY_CODE,
        ticker:         '',           // NOT NULL in DB — overwritten below if ISIN resolves
        company:        item.companyName || null,
        announced_date: pubDate,
        execution_date: pubDate,
        currency:       'EUR',
        status:         'Active',
        filing_url:     STORI_PAGE,
        source_url:     STORI_PAGE,
        source:         SOURCE,
        // Execution data not available from metadata — requires PDF parsing
        shares_bought:  null,
        avg_price:      null,
        total_value:    null,
        // Store auxiliary fields for enrichment
        _isin:          isin,
        _lei:           item.lei || null,
        _file_id:       fileId,
        _market:        market,
      });
    }

    if (cutoffReached) break;
    start += PAGE_SIZE;
    if (start >= total) break;
    await delay(DELAY_MS);
  }

  console.log(`  Fetched ${pages} page(s), found ${dbRows.length} filings in window`);
  if (!dbRows.length) { console.log('  No data.'); return { saved: 0 }; }

  // Resolve ISIN → ticker for rows that have an ISIN
  let resolved = 0;
  for (const r of dbRows) {
    if (r._isin && !r.ticker) {
      try {
        const t = await isinToTicker(r._isin);
        if (t) { r.ticker = t; resolved++; }
      } catch {}
    }
    // Clean up internal fields before DB save
    delete r._isin;
    delete r._lei;
    delete r._file_id;
    delete r._market;
  }
  if (resolved > 0) console.log(`  Resolved ${resolved} tickers from ISIN`);

  // Show sample
  const sample = dbRows.slice(0, 3).map(r => `${r.company} (${r.announced_date})`).join('; ');
  console.log(`  Sample: ${sample}`);

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);

  // Company breakdown
  const byCompany = {};
  for (const r of dbRows) byCompany[r.company] = (byCompany[r.company] || 0) + 1;
  const topCompanies = Object.entries(byCompany).sort((a,b) => b[1]-a[1]).slice(0, 5);
  console.log('  Top filers:', topCompanies.map(([c,n]) => `${c}(${n})`).join(', '));

  return { saved: dbRows.length };
}

scrapeBEBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
