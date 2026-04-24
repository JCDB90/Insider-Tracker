/**
 * KR — Insider Transactions Scraper
 *
 * Source: DART (Data Analysis, Retrieval and Transfer System)
 *         Korea Financial Supervisory Service
 *
 * API base: https://opendart.fss.or.kr/api
 * Requires: DART_API_KEY environment variable
 *   Register free at: https://opendart.fss.or.kr  (Korean)
 *                  or https://engopendart.fss.or.kr  (English)
 *
 * Report type: D003 = 임원ㆍ주요주주소유주식등변동신고서
 *              (Executive / Major Shareholder Stock Change Notification)
 *
 * Flow:
 *   1. list.json?pblntf_ty=D&pblntf_detail_ty=D003
 *      → {corp_name, flr_nm, rcept_dt, rcept_no}
 *   2. document.xml?rcept_no=<id>
 *      → ZIP archive containing DART4 XML document
 *   3. Extract XML from ZIP (yauzl), decode EUC-KR if needed (iconv-lite)
 *   4. Parse DART4 XML by ACODE/AUNIT attributes — NOT Korean text labels:
 *        AUNIT="RPT_RSN" ENG="Acquisition..."  → BUY / SELL / OTHER
 *        AUNIT="MDF_DM"  AUNITVALUE="YYYYMMDD" → transaction date
 *        ACODE="MDF_STK_CNT"                   → shares delta
 *        ACODE="ACI_AMT2"                       → unit price (KRW)
 *        ACODE="IFR_NM"                         → insider name
 *        ACODE="STF_PSM"                        → position/role
 *
 * One filing can contain multiple transactions (one <TR> per trade date).
 */
'use strict';

const https = require('https');
const path  = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { romanizeKoreanName }      = require('./lib/korean');

const COUNTRY_CODE    = 'KR';
const SOURCE          = 'DART / FSS Korea';
const RETENTION_DAYS  = 14;
const CONCURRENCY     = 3;
const DELAY_MS        = 300;
const API_HOST        = 'opendart.fss.or.kr';

// ─── KOSPI 200 filter ─────────────────────────────────────────────────────────
// Static list of KOSPI 200 constituent stock codes (6-digit KRX codes).
// Filters out the ~2,500 smaller KOSPI/KOSDAQ companies to match the quality
// level of DAX 40, CAC 40, AEX 25 etc.  Update quarterly from KRX if needed.
const KOSPI200_RAW  = require(path.join(__dirname, 'lib/kospi200.json'));
const KOSPI200_MAP  = new Map(KOSPI200_RAW.map(c => [c.code, c.name]));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dartDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function dartGet(path) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path,
      headers: {
        'User-Agent': 'InsiderTracker/1.0',
        'Accept': 'application/json,application/zip,application/xml,*/*',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

async function dartGetJson(path) {
  const r = await dartGet(path);
  if (!r) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch { return null; }
}

// ─── Document fetch: ZIP → HTML extraction ───────────────────────────────────

/**
 * Detect encoding from a buffer's first 500 bytes and decode accordingly.
 * DART documents are often EUC-KR encoded.
 */
function decodeKorean(buffer) {
  const peek = buffer.slice(0, 500).toString('ascii');
  if (/charset=['"]*euc-kr|encoding=['"]*euc-kr/i.test(peek)) {
    try {
      return require('iconv-lite').decode(buffer, 'EUC-KR');
    } catch { /* iconv-lite not available, fall through */ }
  }
  return buffer.toString('utf8');
}

/**
 * Extract all HTML/XML file contents from a ZIP buffer using yauzl.
 */
function extractHtmlFromZip(buffer) {
  return new Promise((resolve) => {
    let yauzl;
    try { yauzl = require('yauzl'); } catch { resolve(null); return; }

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) { resolve(null); return; }
      const parts = [];

      zipfile.readEntry();

      zipfile.on('entry', entry => {
        if (/\.(html?|xml|htm)$/i.test(entry.fileName) &&
            !entry.fileName.includes('__MACOSX')) {
          zipfile.openReadStream(entry, (err, stream) => {
            if (err) { zipfile.readEntry(); return; }
            const chunks = [];
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => {
              parts.push(decodeKorean(Buffer.concat(chunks)));
              zipfile.readEntry();
            });
            stream.on('error', () => zipfile.readEntry());
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on('end',   () => resolve(parts.join('\n') || null));
      zipfile.on('error', () => resolve(parts.join('\n') || null));
    });
  });
}

/**
 * Fetch DART filing document.
 * Returns raw text (HTML/XML) — handles both ZIP and plain-text responses.
 */
async function dartGetDocument(apiKey, rcptNo) {
  const r = await dartGet(
    `/api/document.xml?crtfc_key=${apiKey}&rcept_no=${encodeURIComponent(rcptNo)}`
  );
  if (!r) return null;

  // ZIP magic bytes: PK\x03\x04 → 50 4B 03 04
  if (r.body.length > 4 && r.body[0] === 0x50 && r.body[1] === 0x4B) {
    return extractHtmlFromZip(r.body);
  }

  // Plain XML/HTML response
  return decodeKorean(r.body);
}

// ─── DART XML parser ──────────────────────────────────────────────────────────

/**
 * Parse a DART D003 document (DART4 XML format) into an array of transactions.
 *
 * DART documents are NOT HTML tables — they use custom XML with ACODE/AUNIT
 * attributes to identify structured data fields. Korean label text is irrelevant.
 *
 * Key attributes:
 *   AUNIT="RPT_RSN"  ENG="Acquisition in exchange(+)"  → BUY/SELL/OTHER
 *   AUNIT="MDF_DM"   AUNITVALUE="20260413"              → transaction date
 *   ACODE="MDF_STK_CNT"                                 → shares delta (text)
 *   ACODE="ACI_AMT2"                                    → unit price (text)
 *   ACODE="IFR_NM"                                      → insider name
 *   ACODE="STF_PSM"                                     → position/role
 *
 * One filing can contain multiple transactions (one <TR> per trade date).
 * Returns an array of transaction objects (empty array if none are BUY/SELL).
 */
function parseDocument(docContent) {
  if (!docContent || typeof docContent !== 'string') return [];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Get text content of first element with ACODE="code"
  function getAcode(xml, code) {
    const re = new RegExp(`ACODE=["']${code}["'][^>]*>([^<]*)`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim() : null;
  }

  // Get AUNITVALUE of first element with AUNIT="unit"
  function getAunitValue(xml, unit) {
    // attribute order: AUNIT first, then AUNITVALUE
    let m = xml.match(new RegExp(`AUNIT=["']${unit}["'][^>]*AUNITVALUE=["']([^"']*)["']`, 'i'));
    if (m) return m[1].trim();
    // reversed order
    m = xml.match(new RegExp(`AUNITVALUE=["']([^"']*)["'][^>]*AUNIT=["']${unit}["']`, 'i'));
    return m ? m[1].trim() : null;
  }

  // Get ENG attribute of first element with AUNIT="unit"
  function getAunitEng(xml, unit) {
    let m = xml.match(new RegExp(`AUNIT=["']${unit}["'][^>]*ENG=["']([^"']*)["']`, 'i'));
    if (m) return m[1].trim();
    m = xml.match(new RegExp(`ENG=["']([^"']*)["'][^>]*AUNIT=["']${unit}["']`, 'i'));
    return m ? m[1].trim() : null;
  }

  function parseNum(s) {
    if (!s || s.trim() === '-') return null;
    const clean = s.replace(/[,\s원주]/g, '').replace(/[^0-9\-]/g, '');
    const n = parseInt(clean, 10);
    return isNaN(n) ? null : n;
  }

  function parseDate8(s) {
    if (!s || s === '-') return null;
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    const m = s.match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    return null;
  }

  // ── Document-level fields (same for all transactions in the filing) ──────────

  const insiderName = getAcode(docContent, 'IFR_NM') || null;
  const role        = getAcode(docContent, 'STF_PSM') || null;

  // ── Per-transaction rows (find all <TR> blocks containing RPT_RSN) ───────────
  // DART XML has one <TR> per transaction date in the "세부변동내역" table
  const trBlocks = docContent.match(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi) || [];
  const txns = [];

  for (const tr of trBlocks) {
    // Skip rows that don't have a RPT_RSN (these are header rows, totals, etc.)
    if (!tr.includes('RPT_RSN')) continue;

    const reasonEng = getAunitEng(tr, 'RPT_RSN') || '';
    const dateValue  = getAunitValue(tr, 'MDF_DM') || '';
    const sharesRaw  = getAcode(tr, 'MDF_STK_CNT');
    const priceRaw   = getAcode(tr, 'ACI_AMT2');

    // BUY/SELL from the English label DART provides on every RPT_RSN element
    const eng = reasonEng.toLowerCase();
    let txType = 'OTHER';
    if (eng.includes('acquisition') || eng.includes('exercise') ||
        eng.includes('allotment')   || eng.includes('grant')) {
      txType = 'BUY';
    } else if (eng.includes('disposition') || eng.includes('transfer') ||
               eng.includes('sale')        || eng.includes('disposal')) {
      txType = 'SELL';
    }

    // Skip non-market events (capital reduction, bonus issue, rights, etc.)
    if (txType === 'OTHER') continue;

    const shares = parseNum(sharesRaw);
    const price  = parseNum(priceRaw);
    const date   = parseDate8(dateValue);

    txns.push({
      txType,
      shares: shares !== null ? Math.abs(shares) : null,
      price:  price  !== null && price > 0 ? price : null,
      transDate: date,
      reasonEng,
    });
  }

  // Also expose document-level name/role for the caller
  return { txns, insiderName, role };
}

// ─── Batch concurrency helper ─────────────────────────────────────────────────

async function runBatch(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      results.push(await fn(item));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeKR() {
  console.log('🇰🇷  DART Korea — 임원ㆍ주요주주 주식변동 (D003)');
  const t0 = Date.now();

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.log('  ⚠  DART_API_KEY not set.');
    console.log('  ℹ  Register: https://opendart.fss.or.kr (KR) / https://engopendart.fss.or.kr (EN)');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const today  = new Date();
  const cutoff = new Date(today.getTime() - RETENTION_DAYS * 86400000);
  const bgn = dartDate(cutoff);
  const end = dartDate(today);
  console.log(`  Range: ${bgn} → ${end}`);

  // ── 1. Fetch D003 filing list ──────────────────────────────────────────────
  const allListings = [];
  let page = 1;
  while (true) {
    const data = await dartGetJson(
      `/api/list.json?crtfc_key=${apiKey}&bgn_de=${bgn}&end_de=${end}` +
      `&pblntf_ty=D&pblntf_detail_ty=D003&page_no=${page}&page_count=100`
    );

    if (!data) { console.error('  API error — no response'); break; }
    if (data.status !== '000') {
      console.error(`  DART API: ${data.status} — ${data.message}`);
      break;
    }

    const items = data.list || [];
    allListings.push(...items);

    const total = parseInt(data.total_count || '0', 10);
    if (allListings.length >= total || items.length === 0) break;
    console.log(`  Page ${page}: ${items.length} items (${allListings.length}/${total} total)`);
    page++;
    await delay(DELAY_MS);
  }

  console.log(`  ${allListings.length} D003 filings found`);
  if (!allListings.length) { console.log('  No data.'); return { saved: 0 }; }

  // ── 1b. Filter to KOSPI 200 only ──────────────────────────────────────────
  // corp_cls 'Y' = KOSPI (유가증권시장); stock_code is the 6-digit KRX code.
  const kospiListings = allListings.filter(m => {
    if (m.corp_cls !== 'Y') return false;              // drop KOSDAQ / KONEX / OTC
    const sc = (m.stock_code || '').replace(/\s/g, '');
    return sc && KOSPI200_MAP.has(sc);
  });
  console.log(`  ${kospiListings.length} filings after KOSPI 200 filter (${allListings.length - kospiListings.length} dropped)`);
  if (!kospiListings.length) { console.log('  No KOSPI 200 data.'); return { saved: 0 }; }

  // ── 2. Fetch + parse each document ────────────────────────────────────────
  let nFetched = 0, nParsed = 0, nFailed = 0;

  const processListing = async (listing) => {
    const rcptNo     = listing.rcept_no;
    const filingDate = rcptNo
      ? `${rcptNo.slice(0,4)}-${rcptNo.slice(4,6)}-${rcptNo.slice(6,8)}`
      : null;

    const sc              = (listing.stock_code || '').replace(/\s/g, '');
    const company         = KOSPI200_MAP.get(sc) || listing.corp_name?.trim() || null;
    const insiderNameList = listing.flr_nm?.trim() || null;

    await delay(DELAY_MS);
    const docContent = await dartGetDocument(apiKey, rcptNo);
    nFetched++;

    if (!docContent ||
        docContent.includes('"status":"010"') ||
        docContent.includes('잘못된')) {
      nFailed++;
      return [];
    }

    // parseDocument returns { txns: [...], insiderName, role }
    // txns is already filtered to BUY/SELL only
    const result = parseDocument(docContent);
    if (!result || !result.txns || result.txns.length === 0) return [];
    nParsed++;

    const nameFromDoc = result.insiderName || null;
    const role        = result.role        || null;
    const name        = nameFromDoc || insiderNameList;
    if (!name) return [];

    const filingUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcptNo}`;

    // Determine if filer is an institution (5+ Hangul chars = corporate entity)
    const hangulCount = name ? [...name].filter(c => /[가-힯]/.test(c)).length : 0;
    const isCorporateFiler = hangulCount > 4;
    const romanizedName = romanizeKoreanName(name);

    // One DB row per transaction (filings can contain multiple trade dates)
    return result.txns.map((txn, idx) => ({
      filing_id:        `KR-${rcptNo}-${txn.transDate || filingDate}-${idx}`,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           sc || listing.corp_code || null,
      company,
      insider_name:     isCorporateFiler ? null : romanizedName,
      via_entity:       isCorporateFiler ? romanizedName : null,
      insider_role:     translateRole(role),
      transaction_type: txn.txType,
      transaction_date: txn.transDate || filingDate,
      shares:           txn.shares,
      price_per_share:  txn.price,
      total_value:      (txn.price && txn.shares) ? Math.round(txn.shares * txn.price) : null,
      currency:         'KRW',
      filing_url:       filingUrl,
    }));
  };

  const rawRows  = await runBatch(kospiListings, CONCURRENCY, processListing);
  const flatRows = rawRows.flat().filter(Boolean);

  console.log(`  Fetched: ${nFetched} | Parsed docs: ${nParsed} | Doc errors: ${nFailed}`);

  const buys   = flatRows.filter(r => r.transaction_type === 'BUY').length;
  const sells  = flatRows.filter(r => r.transaction_type === 'SELL').length;
  const others = flatRows.filter(r => r.transaction_type === 'OTHER').length;
  console.log(`  Rows: ${flatRows.length} total — ${buys} BUY, ${sells} SELL, ${others} OTHER (will be dropped)`);

  // Preview first 3 BUY/SELL rows
  const preview = flatRows.filter(r => r.transaction_type !== 'OTHER').slice(0, 3);
  for (const r of preview) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares ?? 'n/a'} shares @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  if (!flatRows.length) { console.log('  No rows to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(flatRows);
  if (error) { console.error('  ❌ DB error:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${buys + sells} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: buys + sells };
}

scrapeKR().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
