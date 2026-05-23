/**
 * LU — Insider Transactions Scraper
 *
 * Source: Luxembourg Stock Exchange (LuxSE) — OAM Managers' Transactions
 * API:    https://graphqlaz.luxse.com/v1/graphql  (Apollo GraphQL)
 * PDF:    https://dl.luxse.com/dl?v=<encodeURIComponent(documentUrl)>
 *
 * Primary source: OAM oamSubmissionsSearch (comprehensive — ~116 filings / 90 days)
 * Not used: FNS latestFNSDocuments — only returns a subset (~2 / 2 weeks)
 *
 * Flow:
 *   1. oamSubmissionsSearch(publicationStartDate, publicationEndDate, countryCodeIso='LU')
 *   2. Filter for "Managers' transactions" (submissionTypeLabel, U+2019 apostrophe)
 *   3. oamSubmissionDetail(submissionId) → encrypted document URL
 *   4. Download PDF from dl.luxse.com/dl?v=<encodeURIComponent(url)>
 *   5. pdftotext -layout → parse ESMA HOS-2 form fields
 *   6. Save to Supabase (filing_id: LU-OAM-{submissionId})
 *
 * GitHub Actions: requires poppler-utils (pdftotext) — already installed in workflow.
 */
'use strict';

const https        = require('https');
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { isinToTicker }            = require('./lib/isinToTicker');

const COUNTRY_CODE   = 'LU';
const SOURCE         = 'LuxSE — Manager Transactions';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
const DL_BASE        = 'https://dl.luxse.com/dl?v=';
const CONCURRENCY    = 3;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── GraphQL helpers ──────────────────────────────────────────────────────────

function gql(body) {
  return new Promise((resolve) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'graphqlaz.luxse.com',
      path: '/v1/graphql',
      method: 'POST',
      headers: {
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Origin':        'https://www.luxse.com',
        'Referer':       'https://www.luxse.com/',
        'Content-Length': buf.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.write(buf);
    req.end();
  });
}

// ─── OAM search ───────────────────────────────────────────────────────────────

const OAM_SEARCH_QUERY = `
  query GetOamSubmissionsSearch(
    $depositType: Int, $issuerName: String, $referenceYear: Int,
    $cssfCode: String, $isin: String,
    $publicationStartDate: Date, $publicationEndDate: Date,
    $countryCodeIso: String, $pageSize: Int, $pageNumber: Int
  ) {
    oamSubmissionsSearch(
      depositType: $depositType, issuerName: $issuerName,
      referenceYear: $referenceYear, cssfCode: $cssfCode, isin: $isin,
      publicationStartDate: $publicationStartDate, publicationEndDate: $publicationEndDate,
      countryCodeIso: $countryCodeIso, pageSize: $pageSize, pageNumber: $pageNumber
    ) {
      totalHits
      submissions {
        submissionId submissionTypeLabel publicationDate
        referenceStartDate issuerName
      }
    }
  }
`;

const OAM_DETAIL_QUERY = `
  query GetOamSubmissionDetail($submissionId: Float!) {
    oamSubmissionDetail(submissionId: $submissionId) {
      documents { fileName url size publicationDate category obsolete }
    }
  }
`;

async function fetchOamSubmissions(fromDate, toDate) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await gql({
      query: OAM_SEARCH_QUERY,
      variables: {
        depositType: null, issuerName: null, referenceYear: null,
        cssfCode: null, isin: null,
        publicationStartDate: fromDate, publicationEndDate: toDate,
        countryCodeIso: 'LU', pageSize: 100, pageNumber: page,
      },
    });
    const subs = r?.data?.oamSubmissionsSearch?.submissions || [];
    if (!subs.length) break;
    all.push(...subs);
    if (subs.length < 100) break;
    page++;
  }
  // "Managers' transactions" — submissionTypeLabel uses U+2019 right-quote
  return all.filter(s => /transactions/i.test(s.submissionTypeLabel));
}

async function fetchOamDocumentUrl(submissionId) {
  const r = await gql({
    query: OAM_DETAIL_QUERY,
    variables: { submissionId },
  });
  const docs = r?.data?.oamSubmissionDetail?.documents || [];
  // Take the first non-obsolete PDF document
  const doc = docs.find(d => !d.obsolete) || docs[0];
  return doc?.url || null;
}

// ─── PDF download ─────────────────────────────────────────────────────────────

function downloadPdf(encodedUrl) {
  return new Promise((resolve) => {
    const url = DL_BASE + encodeURIComponent(encodedUrl);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/pdf,*/*',
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
    return execSync(`pdftotext -layout "${tmp}" -`, { encoding: 'utf8', timeout: 15000 });
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ─── PDF form parsers ─────────────────────────────────────────────────────────

/*
 * Two PDF formats used by LuxSE filers:
 *
 * 1. HOS-2 form (standard CSSF format, most filers):
 *    "Label text          <3+ spaces>   Value text"
 *    Fields: Name1, Name4, Position/status2, Nature of the transaction8,
 *            Aggregated volume10, Price11 (= total value EUR), Date of the transaction12
 *
 * 2. UK/English notification format (Eurofins, SES, etc.):
 *    "a)    Name                         Laurent Lebras"
 *    "b)    Nature of the transaction    Acquisition"
 *    "      — Aggregated volume          1000"
 *    "d)    — Price                      EUR 62.00"   ← per-share price
 *    "e)    Date of the transaction      2026-05-21"
 */
function parsePdf(text) {
  if (!text) return {};

  const notesIdx = text.search(/^Notes\s*$/m);
  const body = notesIdx > 0 ? text.slice(0, notesIdx) : text;
  const lines = body.split('\n');

  // ISIN extraction is format-agnostic
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

  function getField(labelRe, minSpaces) {
    const sp = minSpaces || 3;
    const gapRe = new RegExp(`\\s{${sp},}(.+)$`);
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      const m = lines[i].match(gapRe);
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

  // Detect UK/English notification format by presence of a)/b) section labels
  const isEnFormat = /^\s*a\)\s+Name\b/m.test(body) || /^\s*b\)\s+Nature of the transaction/m.test(body);

  if (isEnFormat) {
    // EN format: value columns are typically 5+ spaces after the label keyword
    function getEnField(labelRe, minSpaces) {
      const sp = minSpaces || 5;
      const gapRe = new RegExp(`\\s{${sp},}(.+)$`);
      for (let i = 0; i < lines.length; i++) {
        if (!labelRe.test(lines[i])) continue;
        const m = lines[i].match(gapRe);
        let val = m ? m[1].trim() : '';
        for (let j = i + 1; j < lines.length; j++) {
          const nl = lines[j];
          if (!nl.trim()) continue;
          if (/^\s{15,}/.test(nl) && !/^\s*[a-f]\)/.test(nl.trim())) val += ' ' + nl.trim();
          else break;
        }
        return val.trim() || null;
      }
      return null;
    }

    const insiderName = getEnField(/^\s*a\)\s+Name\b/);
    const issuerName  = getEnField(/Name of (?:the )?issuer/i) || getEnField(/^\s*d\)\s+Name\b/);

    // Nature text: try b) label first, then bare label fallback
    const natureTxt = getEnField(/^\s*b\)\s+Nature of the transaction/i)
                   || getEnField(/\bNature of the transaction\b/i)
                   || '';
    let txType = 'UNKNOWN';
    const natLow = natureTxt.toLowerCase();
    if (/dispos|sale\b|sell/.test(natLow))                              txType = 'SELL';
    else if (/acqui|purchas|subscri|exercise|award|grant|vest/.test(natLow)) txType = 'BUY';

    // Final fallback: broad scan for transaction type keywords
    if (txType === 'UNKNOWN') {
      for (const line of lines) {
        const ll = line.toLowerCase();
        if (/\bdisposal\b|\bsale of\b|\bselling\b/.test(ll)) { txType = 'SELL'; break; }
        if (/\bacquisition\b|\bpurchase of\b|\bexercise of\b/.test(ll)) { txType = 'BUY'; break; }
      }
    }

    let shares = null;
    for (let i = 0; i < lines.length; i++) {
      if (/[—–-]\s*Aggregated volume/i.test(lines[i])) {
        const m = lines[i].match(/([\d,]+(?:\.\d+)?)\s*$/);
        if (m) shares = parseFloat(m[1].replace(/,/g, '')) || null;
        break;
      }
    }

    // — Price = aggregate total value in EN format (same semantics as HOS-2 Price11)
    // pricePerShare derived as totalValue / shares
    let totalValue = null;
    for (let i = 0; i < lines.length; i++) {
      if (/[—–-]\s*Price\b/i.test(lines[i])) {
        const mEur = lines[i].match(/EUR\s+([\d,]+\.?\d*)/i);
        const mNum = lines[i].match(/([\d,]+\.?\d*)\s*(?:EUR|USD)?\s*$/i);
        const raw = mEur ? mEur[1] : (mNum ? mNum[1] : null);
        if (raw) totalValue = parseFloat(raw.replace(/,/g, '')) || null;
        break;
      }
    }

    let pricePerShare = null;
    if (totalValue && shares && shares > 0) {
      pricePerShare = parseFloat((totalValue / shares).toFixed(6));
    }

    const dateTxt = getEnField(/^\s*e\)\s+Date of the transaction/i) || '';
    let txDate = null;
    const dmIso = dateTxt.match(/(\d{4}-\d{2}-\d{2})/);
    if (dmIso) txDate = dmIso[1];
    if (!txDate) {
      const dmDmy = dateTxt.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/);
      if (dmDmy) txDate = `${dmDmy[3]}-${dmDmy[2].padStart(2,'0')}-${dmDmy[1].padStart(2,'0')}`;
    }

    return { insiderName, issuerName, isin, role: null, txType, shares, totalValue, pricePerShare, txDate };
  }

  // Standard HOS-2 form
  // Fallback to 1-space gap for narrow-column PDFs (e.g. Grand City Properties)
  const insiderName = getField(/\bName1\b/) || getField(/\bName1\b/, 1);
  const issuerName  = getField(/\bName4\b/) || getField(/\bName4\b/, 1);

  const roleRaw = getField(/Position\/status\d/) || '';
  let role = null;
  const rm = roleRaw.match(/\b(CEO|CFO|COO|CTO|Chairman|President|Director|Secretary|Manager|Partner|Member)\b/i);
  if (rm) role = rm[1];
  else if (/closely associated/i.test(roleRaw)) role = 'Closely Associated';

  const natureTxt = getField(/Nature of the transaction\d/) || '';
  let txType = 'UNKNOWN';
  const natLow = natureTxt.toLowerCase();
  if (/dispos|sale\b|sell/.test(natLow))               txType = 'SELL';
  else if (/acqui|purchas|subscri|exercise/.test(natLow)) txType = 'BUY';

  const volTxt = getField(/Aggregated volume\d+/) || '';
  let shares = null;
  const vm = volTxt.match(/([\d,]+)/);
  if (vm) shares = parseFloat(vm[1].replace(/,/g, '')) || null;

  const priceTxt = getField(/\bPrice1[0-9]\b/) || '';
  let totalValue = null;
  const pm = priceTxt.match(/([\d,]+\.?\d*)/);
  if (pm) totalValue = parseFloat(pm[1].replace(/,/g, '')) || null;

  let pricePerShare = null;
  if (totalValue && shares && shares > 0) {
    pricePerShare = parseFloat((totalValue / shares).toFixed(6));
  }

  const dateTxt = getField(/Date of the transaction\d+/) || '';
  let txDate = null;
  const dm = dateTxt.match(/(\d{4}-\d{2}-\d{2})/);
  if (dm) txDate = dm[1];

  return { insiderName, issuerName, isin, role, txType, shares, totalValue, pricePerShare, txDate };
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function pool(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeLU() {
  console.log('🇱🇺  LuxSE — OAM Managers\' Transactions');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const submissions = await fetchOamSubmissions(from, to);
  console.log(`  OAM returned ${submissions.length} managers' transaction submissions`);
  if (!submissions.length) { console.log('  Nothing to process.'); return { saved: 0 }; }

  const dbRows = [];
  const seen   = new Set();

  await pool(submissions, async (sub) => {
    const fid = `LU-OAM-${sub.submissionId}`;
    if (seen.has(fid)) return;
    seen.add(fid);

    const publishIso = (sub.publicationDate || '').slice(0, 10);
    const refIso     = (sub.referenceStartDate || '').slice(0, 10);

    // Get document URL from detail query
    const docUrl = await fetchOamDocumentUrl(sub.submissionId);
    if (!docUrl) {
      console.log(`  ⚠  ${sub.submissionId} (${sub.issuerName}) — no document URL`);
      return;
    }

    // Download + parse PDF
    const buf = await downloadPdf(docUrl);
    if (!buf) {
      console.log(`  ⚠  ${sub.submissionId} (${sub.issuerName}) — PDF download failed`);
      return;
    }

    const txt = pdfBufToText(buf);
    const f   = parsePdf(txt);

    // Strip HOS-2 label artifacts that leak into OAM metadata (e.g. "Name4   Grand City Properties")
    const stripLabel = s => s ? s.replace(/^Name\d[\s\t]+/i, '').trim() || null : null;
    const company = stripLabel(f.issuerName) || stripLabel(sub.issuerName) || null;
    const isin    = f.isin || '';
    const txDate  = f.txDate || refIso || publishIso || from;
    const txType  = f.txType !== 'UNKNOWN' ? f.txType : 'UNKNOWN';
    const total   = f.totalValue ? Math.round(f.totalValue) : null;
    const pdfUrl  = DL_BASE + encodeURIComponent(docUrl);

    process.stdout.write(`  → ${sub.submissionId} ${(company || '?').slice(0, 28).padEnd(28)} ${txType.padEnd(4)} ${f.shares || '?'} @ ${f.pricePerShare || '?'} EUR  ${txDate}\n`);

    const ticker = isin ? (await isinToTicker(isin, COUNTRY_CODE) || isin) : '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company,
      insider_name:     stripLabel(f.insiderName) || 'Company Officer',
      insider_role:     f.role,
      transaction_type: txType,
      transaction_date: txDate,
      shares:           f.shares,
      price_per_share:  f.pricePerShare,
      total_value:      total,
      currency:         CURRENCY,
      filing_url:       pdfUrl,
      source:           SOURCE,
    });
  }, CONCURRENCY);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { inserted, error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${inserted ?? dbRows.length} rows saved (${dbRows.length} processed)`);
  return { saved: dbRows.length };
}

scrapeLU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
