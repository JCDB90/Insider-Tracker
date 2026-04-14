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
 *      → {corp_name, flr_nm, rcept_dt, rcept_no, rm}
 *   2. document.xml?rcept_no=<id>
 *      → ZIP archive containing HTML document file(s)
 *   3. Extract HTML from ZIP (yauzl), decode EUC-KR if needed (iconv-lite)
 *   4. Parse Korean HTML table for:
 *        변동이유 (change reason)  → BUY (취득/매수) / SELL (처분/매도)
 *        변동수량 (change qty)     → shares
 *        단가 (unit price)         → price_per_share
 *        변동일 (change date)      → transaction_date
 *        직위 (position/role)      → insider_role
 *        성명 (name)               → insider_name
 *
 * Key parsing notes:
 *  - document.xml response is a ZIP (PK magic bytes 50 4B)
 *  - Inside the ZIP: .htm/.html/.xml files, often EUC-KR encoded
 *  - DART HTML labels use &nbsp; between characters: 변&nbsp;동&nbsp;수&nbsp;량
 *  - Table structure: <td>LABEL</td><td>VALUE</td> — must match </td> before next <td>
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE    = 'KR';
const SOURCE          = 'DART / FSS Korea';
const RETENTION_DAYS  = 14;
const CONCURRENCY     = 3;
const DELAY_MS        = 300;
const API_HOST        = 'opendart.fss.or.kr';

// ─── Korean BUY/SELL keyword sets ────────────────────────────────────────────

const BUY_KW  = /취득|매수|매입|인수|교부|배정|신주인수|스톡옵션.*행사|우리사주|장내매수/;
const SELL_KW = /처분|매도|매각|양도|상환|소각|장내매도|장외매도/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dartDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Allow \s* between each character in a Korean string so we match
 * labels with &nbsp; or spaces: "변동이유" → /변\s*동\s*이\s*유/
 */
function krPat(str) {
  return str.split('').join('\\s*');
}

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

// ─── Korean HTML table parser ─────────────────────────────────────────────────

/**
 * Parse a DART D003 document (HTML or XML) into structured fields.
 *
 * DART HTML structure:
 *   <td>변&nbsp;동&nbsp;이&nbsp;유</td><td>취득(장내매수)</td>
 *
 * After decoding &nbsp; → space and normalizing whitespace:
 *   <td>변 동 이 유 </td><td>취득(장내매수)</td>
 *
 * The grab() function matches:  LABEL_PATTERN </td> <td> VALUE
 */
function parseDocument(docContent) {
  if (!docContent || typeof docContent !== 'string') return null;

  // Normalize: decode all HTML entities first, then collapse whitespace
  const html = docContent
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&amp;/g,  '&')
    .replace(/&nbsp;/g, ' ')     // ← critical: DART labels use &nbsp; between chars
    .replace(/&#xA;/g,  ' ')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/\s+/g, ' ');

  /**
   * Find the value in the <td> that immediately follows a <td> matching labelPat.
   *
   * Handles both:
   *   <td>LABEL</td><td>VALUE</td>            (label in its own cell)
   *   <td>LABEL</td><td colspan="3">VALUE      (value cell with attributes)
   *
   * Also handles the case where the label row is separate from the value row:
   *   <tr><td colspan="4">변동이유</td></tr><tr><td colspan="4">취득</td></tr>
   */
  function grab(labelPats, maxLen = 300) {
    for (const pat of labelPats) {
      // Format A: label and value in adjacent <td> cells on same row
      // Pattern: {label-text} </td> <td...> {value}
      const reA = new RegExp(
        pat + '[^<]{0,80}<\\/(?:td|th)[^>]*> ?<(?:td|th)[^>]*> ?([^<]{1,' + maxLen + '})',
        'i'
      );
      let m = html.match(reA);
      if (m?.[1]?.trim()) return m[1].trim();

      // Format B: label in a header row spanning all columns, value in next row's first <td>
      // Pattern: {label-text} </td></tr> <tr> <td...> {value}
      const reB = new RegExp(
        pat + '[^<]{0,80}<\\/(?:td|th)[^>]*>[^<]*<\\/tr>[^<]*<tr>[^<]*<(?:td|th)[^>]*> ?([^<]{1,' + maxLen + '})',
        'i'
      );
      m = html.match(reB);
      if (m?.[1]?.trim()) return m[1].trim();
    }
    return null;
  }

  // ── Field extraction ────────────────────────────────────────────────────────

  // 변동이유 / 취득처분사유 — reason for change (→ BUY/SELL)
  const reasonRaw = grab([
    krPat('변동이유'),
    krPat('변동사유'),
    krPat('취득사유'),
    krPat('처분사유'),
    krPat('취득처분사유'),
    krPat('소유주식변동사유'),
  ]);

  // 변동수량 / 변동주식수 — quantity of shares changed
  const changeQtyRaw = grab([
    krPat('변동수량'),
    krPat('변동주식수'),
    krPat('취득처분수량'),
    krPat('취득수량'),
    krPat('처분수량'),
  ]);

  // 단가 / 취득단가 — unit price per share
  const priceRaw = grab([
    krPat('단가'),
    krPat('취득단가'),
    krPat('처분단가'),
    krPat('거래단가'),
    krPat('1주당가격'),
  ]);

  // 변동일 / 거래일 — date of transaction
  const dateRaw = grab([
    krPat('변동일'),
    krPat('거래일'),
    krPat('취득일'),
    krPat('처분일'),
    krPat('변동발생일'),
  ]);

  // 직위 / 직함 — role/title
  const roleRaw = grab([
    krPat('직위'),
    krPat('직함'),
    krPat('지위'),
    krPat('보고자직위'),
  ]);

  // 성명 / 보고자 — person name
  const nameRaw = grab([
    krPat('성명'),
    krPat('보고자'),
    krPat('신고인'),
  ]);

  // ── Transaction type from reason ────────────────────────────────────────────
  let txType = 'OTHER';
  if (reasonRaw) {
    const r = reasonRaw.replace(/\s/g, '');
    if (BUY_KW.test(r))       txType = 'BUY';
    else if (SELL_KW.test(r)) txType = 'SELL';
  }

  // ── Number parsers ──────────────────────────────────────────────────────────
  function parseKrNum(s) {
    if (!s) return null;
    const clean = s.replace(/[,\s원주株]/g, '').replace(/[^0-9\-]/g, '').trim();
    const n = parseInt(clean, 10);
    return isNaN(n) ? null : n;
  }

  function parseKrDate(s) {
    if (!s) return null;
    const m1 = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
    const m2 = s.match(/(\d{8})/);
    if (m2) return `${m2[1].slice(0,4)}-${m2[1].slice(4,6)}-${m2[1].slice(6,8)}`;
    return null;
  }

  return {
    txType,
    shares:      parseKrNum(changeQtyRaw),
    price:       parseKrNum(priceRaw),
    transDate:   parseKrDate(dateRaw),
    role:        roleRaw?.replace(/<[^>]+>/g, '').trim() || null,
    nameFromDoc: nameRaw?.replace(/<[^>]+>/g, '').trim() || null,
  };
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

  // ── 2. Fetch + parse each document ────────────────────────────────────────
  let nFetched = 0, nParsed = 0, nFailed = 0;

  const processListing = async (listing) => {
    const rcptNo = listing.rcept_no;
    const filingDate = rcptNo
      ? `${rcptNo.slice(0,4)}-${rcptNo.slice(4,6)}-${rcptNo.slice(6,8)}`
      : null;

    const company     = listing.corp_name?.trim() || null;
    const insiderName = listing.flr_nm?.trim() || null;
    const rm          = (listing.rm || '').trim();

    // Quick BUY/SELL guess from remark (often empty for D003, but try)
    let quickType = 'OTHER';
    if (BUY_KW.test(rm.replace(/\s/g,'')))       quickType = 'BUY';
    else if (SELL_KW.test(rm.replace(/\s/g,''))) quickType = 'SELL';

    await delay(DELAY_MS);
    const docContent = await dartGetDocument(apiKey, rcptNo);
    nFetched++;

    let txType = quickType;
    let shares = null, price = null, transDate = filingDate;
    let role = null, nameFromDoc = null;

    if (docContent &&
        !docContent.includes('"status":"010"') &&
        !docContent.includes('잘못된')) {
      const parsed = parseDocument(docContent);
      if (parsed) {
        if (parsed.txType !== 'OTHER') txType = parsed.txType;
        else if (quickType !== 'OTHER') txType = quickType;
        shares      = parsed.shares;
        price       = parsed.price;
        if (parsed.transDate)   transDate   = parsed.transDate;
        if (parsed.role)        role        = parsed.role;
        if (parsed.nameFromDoc) nameFromDoc = parsed.nameFromDoc;
        nParsed++;
      }
    } else {
      nFailed++;
    }

    const name = nameFromDoc || insiderName;
    if (!name) return null;

    const fid = `KR-${rcptNo || listing.corp_code}-${transDate || filingDate}`;

    return {
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           listing.corp_code || null,
      company,
      insider_name:     name,
      insider_role:     translateRole(role),
      transaction_type: txType,
      transaction_date: transDate || null,
      shares:           shares !== null ? Math.abs(shares) : null,
      price_per_share:  price || null,
      total_value:      (price && shares) ? Math.round(Math.abs(shares) * price) : null,
      currency:         'KRW',
      filing_url:       `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcptNo}`,
    };
  };

  const rawRows  = await runBatch(allListings, CONCURRENCY, processListing);
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
