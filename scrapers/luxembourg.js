/**
 * LU — Insider Transactions Scraper
 *
 * Source: Luxembourg Stock Exchange (LuxSE) — FNS Manager Transaction Statements
 * API:    https://graphqlaz.luxse.com/v1/graphql  (Apollo GraphQL, type=MATS)
 * PDF:    https://dl.luxse.com/dl?v=<encodeURIComponent(downloadUrl)>
 *
 * Flow:
 *   1. GraphQL query for MATS documents (publicationPeriod=TWO_WEEKS_AGO)
 *   2. For each doc, download the HOS-2 PDF via dl.luxse.com/dl?v=...
 *   3. Run pdftotext -layout to get column-aligned text
 *   4. Parse structured fields from the ESMA HOS-2 form layout
 *   5. Save to Supabase
 *
 * Note: ONE_MONTH_AGO / THREE_MONTHS_AGO / SIX_MONTHS_AGO periods return empty
 * results from the API (resultTotalSize=-1). Only TWO_WEEKS_AGO is reliable.
 * For backfill runs use LOOKBACK_DAYS=14 and run daily.
 *
 * GitHub Actions: requires poppler-utils (pdftotext) — already installed in workflow.
 */
'use strict';

const https    = require('https');
const { execSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { isinToTicker }            = require('./lib/isinToTicker');

const COUNTRY_CODE   = 'LU';
const SOURCE         = 'LuxSE — Manager Transactions';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
const DL_BASE        = 'https://dl.luxse.com/dl?v=';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const GQL_QUERY = `
  query GetLatestFnsDocuments(
    $pageable: Boolean!, $pageNumber: Int!, $pageSize: Int!,
    $statOnly: Boolean!, $type: String, $category: String, $publicationPeriod: String
  ) {
    latestFNSDocuments(
      pageable: $pageable, pageNumber: $pageNumber, pageSize: $pageSize,
      statOnly: $statOnly, type: $type, category: $category, publicationPeriod: $publicationPeriod
    ) {
      resultSize
      resultTotalSize
      resultList {
        id
        description
        publishDate
        referenceDate
        documentTypeCode
        documentPublicTypeCode
        complement
        language
        downloadUrl
      }
    }
  }
`;

function fetchMats(publicationPeriod) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      query: GQL_QUERY,
      variables: {
        pageable: false,
        pageNumber: 1,
        pageSize: 200,
        statOnly: false,
        type: 'MATS',
        category: null,
        publicationPeriod,
      },
    }));

    const req = https.request({
      hostname: 'graphqlaz.luxse.com',
      path: '/v1/graphql',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.luxse.com',
        'Referer': 'https://www.luxse.com/',
        'Content-Length': body.length,
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
    req.write(body);
    req.end();
  });
}

// ─── PDF download ─────────────────────────────────────────────────────────────

function downloadPdf(downloadUrl) {
  return new Promise((resolve) => {
    const url = DL_BASE + encodeURIComponent(downloadUrl);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
      },
    }, res => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

function pdfBufToText(buf) {
  const tmp = path.join('/tmp', `luxse-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    // -layout preserves column alignment: "Label          Value" on same line
    return execSync(`pdftotext -layout "${tmp}" -`, { encoding: 'utf8', timeout: 15000 });
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ─── HOS-2 form parser ────────────────────────────────────────────────────────

/*
 * In -layout mode each form row appears as:
 *   "Label text          <3+ spaces>          Value text"
 * Multi-line values continue on lines with 30+ leading spaces.
 *
 * Key fields and their label patterns:
 *   Name1            → insider name
 *   Name4            → issuer name
 *   Position/status2 → role description
 *   Nature of the transaction8 → Acquisition / Disposal
 *   Aggregated volume10        → shares (units)
 *   Price11                    → total value (EUR) — price × volume aggregate
 *   Date of the transaction12  → transaction date (YYYY-MM-DD)
 */
function parsePdf(text) {
  if (!text) return {};

  // Trim footnotes (everything from "Notes" heading at start of line)
  const notesIdx = text.search(/^Notes\s*$/m);
  const body = notesIdx > 0 ? text.slice(0, notesIdx) : text;
  const lines = body.split('\n');

  // Extract the right-hand value from a line matching labelRe.
  // Also collects wrapped continuation lines (30+ leading spaces, no new label).
  function getField(labelRe) {
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      const m = lines[i].match(/\s{3,}(.+)$/);
      let val = m ? m[1].trim() : '';
      for (let j = i + 1; j < lines.length; j++) {
        const nl = lines[j];
        if (!nl.trim()) continue;
        if (/^\s{30,}/.test(nl)) val += ' ' + nl.trim();
        else break;
      }
      return val.trim() || null;
    }
    return null;
  }

  // Insider name (field 1)
  const insiderName = getField(/\bName1\b/);

  // Issuer name (field 4)
  const issuerName = getField(/\bName4\b/);

  // Role (field 2) — extract keyword from free-text description
  const roleRaw = getField(/Position\/status\d/);
  let role = null;
  if (roleRaw) {
    const rm = roleRaw.match(/\b(CEO|CFO|COO|CTO|Chairman|President|Director|Secretary|Manager|Partner|Member)\b/i);
    if (rm) role = rm[1];
    else if (/closely associated/i.test(roleRaw)) role = 'Closely Associated';
    else role = null;
  }

  // ISIN — search "ISIN: <code>" or ISIN on the following line
  let isin = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/);
    if (m) { isin = m[1]; break; }
    if (/ISIN:\s*$/.test(lines[i].trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        const m2 = lines[j].match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
        if (m2) { isin = m2[1]; break; }
      }
      break;
    }
  }

  // Transaction type (field 8)
  const natureTxt = getField(/Nature of the transaction\d/) || '';
  let txType = 'UNKNOWN';
  const natLow = natureTxt.toLowerCase();
  if (/dispos|sale\b|sell/.test(natLow))                          txType = 'SELL';
  else if (/acqui|purchas|subscri|exercise/.test(natLow))         txType = 'BUY';

  // Aggregated volume (field 10) — "1,865 (units)"
  const volTxt = getField(/Aggregated volume\d+/) || '';
  let shares = null;
  const vm = volTxt.match(/([\d,]+)/);
  if (vm) shares = parseFloat(vm[1].replace(/,/g, '')) || null;

  // Aggregated price / total value (field 11) — "4,796.5 EUR"
  const priceTxt = getField(/\bPrice1[0-9]\b/) || '';
  let totalValue = null;
  const pm = priceTxt.match(/([\d,]+\.?\d*)/);
  if (pm) totalValue = parseFloat(pm[1].replace(/,/g, '')) || null;

  // Price per share (derived)
  let pricePerShare = null;
  if (totalValue && shares && shares > 0) {
    pricePerShare = parseFloat((totalValue / shares).toFixed(6));
  }

  // Transaction date (field 12)
  const dateTxt = getField(/Date of the transaction\d+/) || '';
  let txDate = null;
  const dm = dateTxt.match(/(\d{4}-\d{2}-\d{2})/);
  if (dm) txDate = dm[1];

  return { insiderName, issuerName, isin, role, txType, shares, totalValue, pricePerShare, txDate };
}

// ─── Complement fallbacks (used when PDF parsing fails) ──────────────────────

function parseCompanyFromComplement(complement) {
  if (!complement) return null;
  const stripped = complement.replace(/\s*\([^)]*issuers?\)/i, '').trim();
  return stripped.split(',')[0].replace(/\s*-\s*[A-Z]{2}[A-Z0-9]{10}\s.*$/, '').trim() || null;
}

function extractIsinFromComplement(complement) {
  if (!complement) return '';
  const m = complement.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
  return m ? m[1] : '';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeLU() {
  console.log('🇱🇺  LuxSE — MATS Manager Transaction Statements (GraphQL + PDF)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // TWO_WEEKS_AGO is the only reliable period (larger buckets return empty)
  const result = await fetchMats('TWO_WEEKS_AGO');
  if (!result) {
    console.log('  ⚠  LuxSE GraphQL API not accessible.');
    return { saved: 0 };
  }

  const docs = result?.data?.latestFNSDocuments?.resultList || [];
  console.log(`  API returned ${docs.length} MATS documents`);
  if (!docs.length) { console.log('  No MATS documents in window.'); return { saved: 0 }; }

  const cutoffStr = from;
  const seen     = new Set();
  const dbRows   = [];

  for (const r of docs) {
    const txIso = (r.referenceDate || r.publishDate || '').slice(0, 10);
    if (txIso && txIso < cutoffStr) continue;

    const fid = `LU-${r.id}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const publishIso = (r.publishDate || '').slice(0, 10);
    const pdfUrl     = r.downloadUrl ? DL_BASE + encodeURIComponent(r.downloadUrl) : null;

    // Defaults from GraphQL metadata (fallback if PDF parse fails)
    let company   = parseCompanyFromComplement(r.complement);
    let isin      = extractIsinFromComplement(r.complement);
    let txDate    = txIso || publishIso || from;
    let txType    = 'UNKNOWN';
    let insiderName = null;
    let role      = null;
    let shares    = null;
    let price     = null;
    let total     = null;

    // PDF parsing
    if (r.downloadUrl) {
      process.stdout.write(`  → doc ${r.id} (${r.complement?.slice(0,30) || '?'}) — downloading PDF…`);
      const buf = await downloadPdf(r.downloadUrl);
      if (buf) {
        const txt = pdfBufToText(buf);
        const f   = parsePdf(txt);
        if (f.issuerName)    company     = f.issuerName;
        if (f.isin)          isin        = f.isin;
        if (f.txDate)        txDate      = f.txDate;
        if (f.txType !== 'UNKNOWN') txType = f.txType;
        if (f.insiderName)   insiderName = f.insiderName;
        if (f.role)          role        = f.role;
        if (f.shares)        shares      = f.shares;
        if (f.pricePerShare) price       = f.pricePerShare;
        if (f.totalValue)    total       = Math.round(f.totalValue); // bigint col
        process.stdout.write(` ${f.txType} ${f.shares || '?'} shares @ ${f.pricePerShare || '?'} EUR\n`);
      } else {
        process.stdout.write(' PDF download failed\n');
      }
    }

    const ticker = isin ? (await isinToTicker(isin, COUNTRY_CODE) || isin) : '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           ticker,
      company,
      insider_name:     insiderName || 'Company Officer',
      insider_role:     role,
      transaction_type: txType,
      transaction_date: txDate,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         CURRENCY,
      filing_url:       pdfUrl || `https://www.luxse.com/market-overview/market-news?type=MATS`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${dbRows.length} rows saved`);
  return { saved: dbRows.length };
}

scrapeLU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
