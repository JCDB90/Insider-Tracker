/**
 * JP — Insider Transactions Scraper
 *
 * Source: EDINET (Electronic Disclosure for Investors' NETwork) — Japan FSA
 * API: https://disclosure.edinet-api.go.jp/api/v2/documents.json
 *
 * No API key required (public government API).
 *
 * Approach:
 *   1. For each day in the retention window, fetch the document list.
 *   2. Filter for docTypeCode 350 / 360 / 370 (large shareholder reports):
 *        350 = 大量保有報告書       (Initial large-holding report, 5%+ threshold → BUY)
 *        360 = 変更報告書           (Change report — holding increase or decrease)
 *        370 = 訂正大量保有報告書   (Amendment)
 *   3. Save the filing metadata. Shares/price require XBRL parsing (not implemented).
 *
 * Note: EDINET API hostname (disclosure.edinet-api.go.jp) may not resolve from
 * some networks / WSL2. It works fine from Linux VPS (Hetzner, etc.).
 *
 * Columns returned by documents.json:
 *   docID, edinetCode, type, ordinanceCode, docTypeCode, docDescription,
 *   issuerNameJP, issuerNameEN, operatorCodeDEI, operatorNameJP, operatorNameEN,
 *   periodStart, periodEnd, submitDateTime, docInfoEditStatus, disclosureStatus,
 *   xbrlFlag, pdfFlag, attachDocFlag, englishDocFlag, csvFlag, legalStatus
 */
'use strict';

const fetch = require('node-fetch');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'JP';
const SOURCE         = 'EDINET Japan FSA';
const RETENTION_DAYS = 14;
const CURRENCY       = 'JPY';
const DELAY_MS       = 500;
const API_BASE       = 'https://disclosure.edinet-api.go.jp/api/v2';

// Document types for large shareholder reports (5%+ threshold):
// 350 = 大量保有報告書       (Initial large-holding report → BUY)
// 360 = 変更報告書           (Change report — increase or decrease)
// 370 = 訂正大量保有報告書   (Amendment / correction)
const INSIDER_DOC_TYPES = new Set(['350', '360', '370']);

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

async function fetchDayDocs(date) {
  const url = `${API_BASE}/documents.json?date=${date}&type=2`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'InsiderTracker/1.0', 'Accept': 'application/json' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function scrapeJP() {
  console.log('🇯🇵  EDINET Japan FSA');
  const t0 = Date.now();
  const co = cutoff();
  const today = new Date();

  console.log(`  Fetching ${isoDate(co)} → ${isoDate(today)}…`);

  const allRaw = [];
  let d = new Date(co);
  let daysFetched = 0;

  while (d <= today && daysFetched < RETENTION_DAYS + 5) {
    const dateStr = isoDate(d);
    let data;
    try {
      data = await fetchDayDocs(dateStr);
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        console.log('  ⚠  EDINET DNS unreachable (normal in WSL2) — works on Linux VPS');
        return { saved: 0 };
      }
      console.warn(`  ⚠  ${dateStr}: ${err.message}`);
      d = addDays(d, 1);
      daysFetched++;
      continue;
    }

    const docs = (data.results || []).filter(doc =>
      INSIDER_DOC_TYPES.has(String(doc.docTypeCode))
    );
    allRaw.push(...docs.map(doc => ({ ...doc, _date: dateStr })));
    if (docs.length > 0) console.log(`  ${dateStr}: ${docs.length} insider docs`);

    d = addDays(d, 1);
    daysFetched++;
    if (daysFetched % 7 === 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`  ${allRaw.length} raw filings`);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];

  for (const r of allRaw) {
    const txIso = r._date;
    const fid   = `JP-${r.docID || r.edinetCode + '-' + txIso}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    // 350 = initial crossing of 5% threshold → BUY (acquiring a large position)
    // 360 = change report → could be BUY or SELL; UNKNOWN without XBRL detail
    // 370 = amendment → keep as UNKNOWN
    const txType = String(r.docTypeCode) === '350' ? 'BUY' : 'UNKNOWN';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.edinetCode || null,
      company:          r.issuerNameEN || r.issuerNameJP || null,
      insider_name:     r.operatorNameEN || r.operatorNameJP || null,
      insider_role:     null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           null,   // requires XBRL parsing
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       `https://disclosure.edinet-api.go.jp/E01EW/BLMainController.jsp?uji.verb=W1E62071CorporationDisclosureMain&EDINET_CD=${r.edinetCode || ''}&DOC_ID=${r.docID || ''}`,
      source:           SOURCE,
    });
  }

  console.log(`  ${dbRows.length} unique filings`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.company}`).join(', ')}`);
  return { saved: dbRows.length };
}

scrapeJP().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
