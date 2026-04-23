/**
 * LU — Insider Transactions Scraper
 *
 * Source: Luxembourg Stock Exchange (LuxSE) — FNS Manager Transaction Statements
 * API: https://graphqlaz.luxse.com/v1/graphql  (Apollo GraphQL)
 * Query: GetLatestFnsDocuments with type="MATS" (Manager Transaction Statements)
 *
 * Discovered by reverse-engineering /dist/bdl-port-luxse-ssr/static/js/main.*.chunk.js
 * The LuxSE React SPA uses Apollo GraphQL with endpoint graphqlaz.luxse.com.
 *
 * MATS documents contain:
 *   - id: document ID
 *   - description: often contains "Manager Transaction Notification - <Name>"
 *   - publishDate: filing date
 *   - referenceDate: transaction date
 *   - complement: issuer name (may include ISIN for LU-listed stocks)
 *
 * Structured fields (shares, price, transaction type) are in PDF attachments only.
 * The publicationPeriod filter "TWO_WEEKS_AGO" covers the 14-day retention window.
 * Use pageable:false to get all results without pagination issues.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'LU';
const SOURCE         = 'LuxSE — Manager Transactions';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

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

function parseInsiderName(description) {
  if (!description) return null;
  // "Manager Transaction Notification - Lisa Graver"
  // "Reporting on securities transaction - François Gillet"
  const m = description.match(/[-–]\s+(.+)$/);
  if (m) return m[1].trim();
  return null;
}

function mapType(description) {
  if (!description) return 'UNKNOWN';
  const l = description.toLowerCase();
  // SELL first: "repurchase" contains "purchase"; "buyback" contains "buy"
  if (l.includes('sale') || l.includes('disposal') || l.includes('sell')) return 'SELL';
  if (l.includes('acqui') || l.includes('subscription') || l.includes('exercise') ||
      /\bpurchas/.test(l) || /\bbuy\b/.test(l)) return 'BUY';
  return 'UNKNOWN';
}

function parseCompany(complement) {
  if (!complement) return null;
  // "ALVOTECH"
  // "LUXEMPART S.A. - LU2605908552 Luxempart"
  // "BANK OF CYPRUS HOLDINGS PUBLIC LIMITED COMPANY, BANK OF CYPRUS PUBLIC COMPANY LIMITED (2 issuers)"
  // Take the first company name before comma or dash+ISIN
  const stripped = complement.replace(/\s*\([^)]*issuers?\)/i, '').trim();
  const parts = stripped.split(',');
  return parts[0].replace(/\s*-\s*[A-Z]{2}[A-Z0-9]{10}\s.*$/, '').trim() || null;
}

function extractIsin(complement) {
  if (!complement) return '';
  const m = complement.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
  return m ? m[1] : '';
}

async function scrapeLU() {
  console.log('🇱🇺  LuxSE — MATS Manager Transaction Statements (GraphQL API)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const result = await fetchMats('TWO_WEEKS_AGO');

  if (!result) {
    console.log('  ⚠  LuxSE GraphQL API not accessible.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const docs = (result.data && result.data.latestFNSDocuments && result.data.latestFNSDocuments.resultList) || [];
  console.log(`  API returned ${docs.length} MATS documents`);

  if (!docs.length) {
    console.log('  No MATS documents in window.');
    return { saved: 0 };
  }

  // Filter to retention window (referenceDate >= cutoff)
  const cutoffStr = from;
  const seen = new Set();
  const dbRows = [];

  for (const r of docs) {
    const txIso  = (r.referenceDate || r.publishDate || '').slice(0, 10);
    if (txIso && txIso < cutoffStr) continue;

    const fid = `LU-${r.id}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const insiderName = parseInsiderName(r.description);
    const company     = parseCompany(r.complement);
    const isin        = extractIsin(r.complement);
    const publishIso  = (r.publishDate || '').slice(0, 10);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           isin,
      company,
      insider_name:     insiderName || 'Company Officer',
      insider_role:     null,     // in PDF only
      transaction_type: mapType(r.description),  // keyword-matched from description; UNKNOWN rows filtered
      transaction_date: txIso || publishIso || from,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       `https://www.luxse.com/market-overview/market-news?type=MATS`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  console.log(`  ℹ  Note: structured fields (shares, price, type) require PDF parsing.`);
  return { saved: dbRows.length };
}

scrapeLU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
