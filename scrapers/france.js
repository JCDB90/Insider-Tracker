/**
 * FR — Insider Transactions Scraper
 *
 * Source: AMF France — BDIF (Base des décisions et informations financières)
 * API:    https://bdif.amf-france.org/back/api/v1/informations
 *
 * The BDIF frontend is an Angular SPA. The /back/ prefix serves the REST API.
 * Discovered by reverse-engineering chunk-KJITPICD.js from the Angular bundle.
 *
 * TypesInformation=DD → Déclarations Dirigeants (MAR Article 19 manager filings)
 * Date parameters: ISO 8601 (YYYY-MM-DDTHH:mm:ss.000Z)
 * Pagination: From=<offset>&Size=<count>
 *
 * Note: The API returns metadata only (no structured transaction data — no
 * insider name, amounts, or transaction type). The PDF attachment contains
 * the full MAR Form but requires parsing. We save available metadata:
 * filing_id, company, date. Transaction details remain null.
 *
 * Note: /Registre-BDIF/ paths return 500 (Struts2 backend broken); /back/ works.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'FR';
const SOURCE         = 'AMF France / BDIF';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';
const PAGE_SIZE      = 100;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toApiDate(d) {
  return `${isoDate(d)}T00:00:00.000Z`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function fetchPage(fromApi, toApi, from) {
  return new Promise((resolve) => {
    const qs = [
      `TypesInformation=DD`,
      `DateDebut=${encodeURIComponent(fromApi)}`,
      `DateFin=${encodeURIComponent(toApi)}`,
      `From=${from}`,
      `Size=${PAGE_SIZE}`,
    ].join('&');

    const req = https.get({
      hostname: 'bdif.amf-france.org',
      path: `/back/api/v1/informations?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'fr-FR',
        'Referer': 'https://bdif.amf-france.org/',
      },
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
  });
}

async function scrapeFR() {
  console.log('🇫🇷  AMF France — BDIF Déclarations Dirigeants (MAR Article 19)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  const fromApi = toApiDate(co);
  const toApi   = toApiDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const allItems = [];
  let offset = 0;
  let total  = null;
  const MAX_PAGES = 50;
  let page = 0;

  while (page < MAX_PAGES) {
    const data = await fetchPage(fromApi, toApi, offset);
    if (!data) {
      if (offset === 0) {
        console.log('  ⚠  AMF BDIF API not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }

    const items = data.result || [];
    if (!items.length) break;

    if (total === null) {
      total = data.total;
      console.log(`  Total from API: ${total} items`);
    }

    allItems.push(...items);

    if (allItems.length >= total || items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    page++;
  }

  if (!allItems.length) {
    console.log('  No DD filings found.');
    return { saved: 0 };
  }

  const seen = new Set();
  const dbRows = [];

  for (const r of allItems) {
    const numero  = r.numero || r.numeroConcatene || String(r.id || '');
    const fid     = `FR-${numero}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const txIso   = (r.dateInformation || r.datePublication || '').slice(0, 10) || from;
    const company = r.societes && r.societes.length > 0 ? r.societes[0].raisonSociale : null;
    const filingUrl = `https://bdif.amf-france.org/Registre-BDIF/Resultat-de-recherche?docId=${numero}`;

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           '',     // ISIN not returned by API metadata endpoint
      company,
      insider_name:     null,   // in PDF only; not returned by API
      insider_role:     null,
      transaction_type: 'UNKNOWN',  // in PDF only
      transaction_date: txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       filingUrl,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  console.log(`  ℹ  Note: structured transaction details (amounts, insider name) require PDF parsing.`);
  return { saved: dbRows.length };
}

scrapeFR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
