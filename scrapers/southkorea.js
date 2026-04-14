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
 *      → {corp_name, flr_nm (filer=insider), rcept_dt, rcept_no}
 *   2. document.xml?rcept_no=<id>
 *      → Raw document XML/HTML containing transaction details
 *   3. Parse Korean HTML table for:
 *      변동이유 (change reason) → BUY / SELL
 *      변동수량 (change qty)   → shares
 *      단가 (unit price)       → price_per_share
 *      변동일 (change date)    → transaction_date
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE    = 'KR';
const SOURCE          = 'DART / FSS Korea';
const RETENTION_DAYS  = 14;
const CONCURRENCY     = 3;
const DELAY_MS        = 250;
const API_HOST        = 'opendart.fss.or.kr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dartDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function dartGet(path) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path,
      headers: {
        'User-Agent': 'InsiderTracker/1.0 (+https://github.com/insider-tracker)',
        'Accept': 'application/json,application/xml,*/*',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function dartGetJson(path) {
  const r = await dartGet(path);
  if (!r) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch { return null; }
}

// Fetch document XML for a filing — returns raw buffer (XML wrapping HTML content)
async function dartGetDocument(apiKey, rcptNo) {
  const r = await dartGet(`/api/document.xml?crtfc_key=${apiKey}&rcept_no=${encodeURIComponent(rcptNo)}`);
  if (!r) return null;
  return r.body.toString('utf8');
}

// ---------------------------------------------------------------------------
// Korean text → structured data
// ---------------------------------------------------------------------------

// Try to extract the BUY/SELL/price/shares from a DART D003 document
// The document is HTML (sometimes wrapped in XML) with Korean labels
function parseDocument(docContent) {
  if (!docContent) return null;

  // Decode XML entities
  const html = docContent
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#xA;/g, '\n')
    .replace(/\s+/g, ' ');

  function grab(labelPatterns, after = /<td[^>]*>/, maxLen = 200) {
    for (const pat of labelPatterns) {
      const m = html.match(new RegExp(pat + after.source + '([^<]{1,' + maxLen + '})'), 'i');
      if (m && m[1]?.trim().length > 0) return m[1].trim();
    }
    return null;
  }

  // Change reason: 변동이유 / 취득사유 / 소유주식변동사유
  const reasonRaw = grab([
    '변동\\s*이유',
    '취득\\s*사유',
    '소유주식\\s*변동\\s*사유',
    '변동\\s*사유',
  ]);

  // Change quantity: 변동수량 / 변동주식수
  const changeQtyRaw = grab([
    '변동\\s*수량',
    '변동\\s*주식\\s*수',
    '취득처분\\s*수량',
  ]);

  // Unit price: 단가 / 취득단가
  const priceRaw = grab([
    '단\\s*가',
    '취득\\s*단가',
    '처분\\s*단가',
    '거래\\s*단가',
  ]);

  // Change date: 변동일 / 거래일 / 취득일
  const dateRaw = grab([
    '변동\\s*일',
    '거래\\s*일',
    '취득\\s*일',
    '처분\\s*일',
  ]);

  // Position/role: 직위 / 직함
  const roleRaw = grab([
    '직\\s*위',
    '직\\s*함',
    '지\\s*위',
  ]);

  // Filer name (person) from the document — more reliable than flr_nm
  const nameRaw = grab([
    '성\\s*명',
    '보고\\s*자',
    '신고\\s*인',
  ]);

  // Determine transaction type from reason
  let txType = 'OTHER';
  if (reasonRaw) {
    const r = reasonRaw.replace(/\s/g, '');
    if (r.includes('취득') || r.includes('매수') || r.includes('인수') || r.includes('교부')) txType = 'BUY';
    else if (r.includes('처분') || r.includes('매도') || r.includes('양도') || r.includes('상환')) txType = 'SELL';
  }

  // Parse numbers
  function parseKrNum(s) {
    if (!s) return null;
    const clean = s.replace(/[,\s원주]/g, '').trim();
    const n = parseInt(clean, 10);
    return isNaN(n) ? null : n;
  }

  function parseKrDate(s) {
    if (!s) return null;
    const m = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    const m2 = s.match(/(\d{8})/);
    if (m2) return `${m2[1].slice(0,4)}-${m2[1].slice(4,6)}-${m2[1].slice(6,8)}`;
    return null;
  }

  return {
    txType,
    shares: parseKrNum(changeQtyRaw),
    price: parseKrNum(priceRaw),
    transDate: parseKrDate(dateRaw),
    role: roleRaw?.replace(/<[^>]+>/g, '').trim() || null,
    nameFromDoc: nameRaw?.replace(/<[^>]+>/g, '').trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Batch concurrency helper
// ---------------------------------------------------------------------------

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
  return results.flat();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeKR() {
  console.log('🇰🇷  DART Korea — 임원ㆍ주요주주 주식변동 (Executive stock change D003)');
  const t0 = Date.now();

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.log('  ⚠  DART_API_KEY not set.');
    console.log('  ℹ  Register free at: https://opendart.fss.or.kr (KR) or https://engopendart.fss.or.kr (EN)');
    console.log('  ℹ  After getting a key, set env DART_API_KEY=<your_key>');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const today = new Date();
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
      console.error(`  DART API error: ${data.status} — ${data.message}`);
      break;
    }

    const items = data.list || [];
    allListings.push(...items);
    console.log(`  Page ${page}: ${items.length} items (${allListings.length} total)`);

    const total = parseInt(data.total_count || '0', 10);
    if (allListings.length >= total || items.length === 0) break;
    page++;
    await delay(DELAY_MS);
  }

  console.log(`  ${allListings.length} D003 filings found`);
  if (!allListings.length) { console.log('  No data.'); return { saved: 0 }; }

  // ── 2. Fetch document details for each filing ──────────────────────────────
  let fetched = 0, parsed = 0, failed = 0;

  const processListing = async (listing) => {
    const rcptNo = listing.rcept_no;
    const filingDate = rcptNo
      ? `${rcptNo.slice(0,4)}-${rcptNo.slice(4,6)}-${rcptNo.slice(6,8)}`
      : null;

    // Base row from list API
    const base = {
      rcptNo,
      company: listing.corp_name || null,
      insiderName: (listing.flr_nm || '').trim() || null,
      corpCode: listing.corp_code || null,
      corpCls: listing.corp_cls || null,  // Y=KOSPI, K=KOSDAQ, N=KONEX
      filingDate,
      remark: (listing.rm || '').trim(),
    };

    // Quick BUY/SELL guess from remark field
    let quickType = 'OTHER';
    if (base.remark) {
      const rm = base.remark;
      if (rm.includes('취득') || rm.includes('매수')) quickType = 'BUY';
      else if (rm.includes('처분') || rm.includes('매도')) quickType = 'SELL';
    }

    // Try to get detailed document
    await delay(DELAY_MS);
    const docContent = await dartGetDocument(apiKey, rcptNo);
    fetched++;

    let txType = quickType;
    let shares = null, price = null, transDate = filingDate;
    let role = null, nameFromDoc = null;

    if (docContent && !docContent.includes('"status":"010"') && !docContent.includes('잘못된')) {
      const parsed_doc = parseDocument(docContent);
      if (parsed_doc) {
        txType = parsed_doc.txType !== 'OTHER' ? parsed_doc.txType : quickType;
        shares = parsed_doc.shares;
        price = parsed_doc.price;
        if (parsed_doc.transDate) transDate = parsed_doc.transDate;
        role = parsed_doc.role;
        if (parsed_doc.nameFromDoc) nameFromDoc = parsed_doc.nameFromDoc;
        parsed++;
      }
    } else {
      failed++;
    }

    const insiderName = nameFromDoc || base.insiderName;
    if (!insiderName) return [];  // Skip if we can't identify the insider

    const fid = `KR-${rcptNo || base.corpCode}-${transDate || filingDate}`;

    return [{
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           base.corpCode || null,
      company:          base.company || null,
      insider_name:     insiderName,
      insider_role:     translateRole(role),
      transaction_type: txType,
      transaction_date: transDate || null,
      shares:           shares !== null ? Math.abs(shares) : null,
      price_per_share:  price || null,
      total_value:      (price && shares) ? Math.round(Math.abs(shares) * price) : null,
      currency:         'KRW',
      filing_url:       `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcptNo}`,
    }];
  };

  const rows = await runBatch(allListings, CONCURRENCY, processListing);
  const flatRows = rows.flat().filter(Boolean);

  console.log(`  Fetched: ${fetched} | Parsed docs: ${parsed} | Doc failed: ${failed}`);
  console.log(`  Rows to save: ${flatRows.length}`);

  if (!flatRows.length) { console.log('  No rows to save.'); return { saved: 0 }; }

  // Preview
  for (const r of flatRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} shares | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(flatRows);
  if (error) {
    console.error('  ❌ DB error:', error.message);
    process.exit(1);
  }

  const buys  = flatRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = flatRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${flatRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: flatRows.length };
}

scrapeKR().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
