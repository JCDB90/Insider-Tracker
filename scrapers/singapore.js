'use strict';
/**
 * SG — Insider Transactions Scraper (Phase 2 — Director Dealings)
 *
 * Source: SGX Singapore — api.sgx.com/announcements/v1.1/securitycode
 * Category: ANNC14 = "Disclosure of Interest/ Changes in Interest"
 *
 * Approach: Puppeteer SPA intercept
 *   1. Navigate to SGX company-announcements for each STI stock
 *   2. Intercept the /securitycode XHR response (20 most recent items)
 *   3. Filter sub === 'ANNC14'
 *   4. Navigate to the links.sgx.com filing HTML page
 *   5. Extract director name from title / page content
 *   6. Download PDF attachment (Form 1 / Form 2) via pdftotext
 *   7. Parse transaction details (shares, price, type) from PDF
 *   8. Save to insider_transactions table
 *
 * PDF Form 1 key fields (Singapore director interest form):
 *   - "Name of Director" or "Name" section
 *   - "No. of Shares" / "Number of shares"
 *   - "Price Transacted" / "Price per share"
 *   - "Nature of Interest" (Direct / Deemed)
 *   - "Type of Transaction" (Acquisition / Disposal)
 *   - "Date of Transaction" (DD/MM/YYYY)
 *
 * Metadata available WITHOUT PDF (from the SGX API):
 *   - company, stock_code, isin, submission_date, filing_url
 *   - director name extracted from filing title after "::"
 *
 * Rows with no PDF data are saved with shares/price = null
 * and can be enriched by a follow-up PDF parsing run.
 */

const puppeteer               = require('puppeteer');
const { execFile }            = require('child_process');
const fs                      = require('fs');
const os                      = require('os');
const path                    = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'SG';
const CURRENCY       = 'SGD';
const SOURCE         = 'SGX Singapore';
const SGX_BASE       = 'https://www.sgx.com/securities/company-announcements';
const DELAY_MS       = 800;

// STI 30
const STI_STOCKS = [
  'D05','O39','U11','Z74','C6L','S63','G13','F34',
  'N2IU','AJBU','C09','BN4','BS6','C52','H78','J36',
  'J37','M44U','ME8U','S58','T39','U96','V03','W50',
  'Y92','9CI','A17U','S68','U14','T82U',
];

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const DRY_RUN   = args.includes('--dry-run');
const stocksArg = args.find(a => a.startsWith('--stocks='));
const stocksFlag = stocksArg ? stocksArg.split('=')[1].split(',') : null;

const STOCKS = stocksFlag
  ? STI_STOCKS.filter(s => stocksFlag.includes(s))
  : TEST_MODE
    ? STI_STOCKS.slice(0, 3)
    : STI_STOCKS;

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Convert DD/MM/YYYY → YYYY-MM-DD */
function sgxDateToIso(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** submission_date YYYYMMDD → YYYY-MM-DD */
function fmtSubDate(s) {
  if (!s || s.length < 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function parseNum(s) {
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Extract director name from filing title after "::" e.g.
 *  "...::Change in Interest of Executive Chairman, Dr Chua Thian Poh"
 *  "...::Disclosure of Interest of a Director - Wong William"
 *  "...::Disclosure of director's interest"  → null (generic)
 */
function extractNameFromTitle(title) {
  if (!title) return null;
  const after = title.split('::')[1]?.trim() || '';

  // Remove boilerplate prefixes
  const cleaned = after
    .replace(/^Disclosure of Interest of a Director\s*[-–]\s*/i, '')
    .replace(/^Change in Interest of\s*/i, '')
    .replace(/^Disclosure of(?:\s+(?:initial|substantial|direct))?\s+(?:a\s+)?(?:director(?:'s)?|interest)\s*[-–]?\s*/i, '')
    .replace(/^Notice of change in interests of Director\s*/i, '')
    .trim();

  // Must look like a real name: 2+ words, each starting with uppercase
  // Or: "Dr John Smith", "Mr John Smith" etc.
  if (cleaned.length < 4 || /^(new|initial|annual|change|notice|disclosure|substantial|interest)/i.test(cleaned)) return null;
  if (!/[A-Z]/.test(cleaned.slice(0, 2))) return null;

  // Cap at 80 chars
  return cleaned.slice(0, 80) || null;
}

/** Map ANNC14 title / PDF text to BUY / SELL / OTHER */
function mapTransactionType(text) {
  const l = (text || '').toLowerCase();
  if (/acqui|purchase|bought|subscription/i.test(l)) return 'BUY';
  if (/dispos|sale|sold/i.test(l)) return 'SELL';
  return 'OTHER';
}

// ── pdftotext helper ───────────────────────────────────────────────────────────

async function pdfToText(buffer) {
  const tmp = path.join(os.tmpdir(), `sgx-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buffer);
    return await new Promise(resolve => {
      execFile('pdftotext', [tmp, '-'], { maxBuffer: 3 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// ── Parse Singapore Form 1 / Form 2 PDF text ──────────────────────────────────
//
// Form 1 (Director/CEO interest):
//   Part II — DEALINGS (Acquisition/Disposal)
//   No. of Shares: 10,000
//   Price Transacted: 4.32
//   Date of Acquisition/Disposal: 20/05/2026
//
// Form 2 (Substantial shareholder):
//   similar structure

function parseSGXDirectorPDF(text) {
  if (!text || text.length < 50) return null;

  const t = text.replace(/\r\n?/g, '\n');

  // ── Transaction type ─────────────────────────────────────────────────────
  const typeM = t.match(/Nature of (the )?[Tt]ransaction[:\s]*(acquisition|disposal|sale|purchase)/i)
             || t.match(/\b(Acquisition|Disposal|Sale|Purchase)\b/i);
  const txType = typeM
    ? (/acqui|purchase/i.test(typeM[2] || typeM[1]) ? 'BUY' : 'SELL')
    : null;

  // ── Number of shares ─────────────────────────────────────────────────────
  const sharesM = t.match(/No\.\s+of\s+(?:[Ss]hares?|[Uu]nits?)[\s:]*([0-9][0-9,. ]*)/i)
               || t.match(/[Nn]umber of [Ss]hares?[\s:]*([0-9][0-9,. ]*)/i)
               || t.match(/([0-9][0-9,]+)\s+(?:ordinary\s+)?shares?\s+(?:at|@)/i);
  const shares = sharesM ? Math.round(parseNum(sharesM[1]) || 0) || null : null;

  // ── Price ─────────────────────────────────────────────────────────────────
  const priceM = t.match(/Price\s+[Tt]ransacted[\s:]*(?:SGD\s*)?([0-9][0-9,.]*)/i)
              || t.match(/(?:Price|Consideration)\s+per\s+[Ss]hare[\s:]*(?:SGD\s*)?([0-9][0-9,.]*)/i)
              || t.match(/at\s+(?:SGD\s*)?([0-9]+[.,][0-9]+)\s+per\s+share/i);
  const price = priceM ? parseNum(priceM[1]) : null;

  // ── Date of transaction ───────────────────────────────────────────────────
  const dateM = t.match(/Date of (?:Acquisition|Disposal|Transaction|dealing)[\s/]*[:\s]*(\d{2}\/\d{2}\/\d{4})/i)
             || t.match(/Transaction [Dd]ate[\s:]*(\d{2}\/\d{2}\/\d{4})/i)
             || t.match(/(\d{2}\/\d{2}\/\d{4})/);
  const txDate = dateM ? sgxDateToIso(dateM[1]) : null;

  // ── Director name (Form 1 top) ────────────────────────────────────────────
  // "Name of Director: John Smith" or "1. Name: PETER TAN"
  const nameM = t.match(/Name of (?:Director|declarant)[\s:]*([A-Z][a-zA-Z ,.\-]{4,60})/i)
             || t.match(/^1\.\s+Name[\s:]+([A-Z][A-Z ,.\-]{4,60})/m);
  const dirName = nameM ? nameM[1].trim().replace(/\s+/g, ' ').slice(0, 80) : null;

  // ── Total value ───────────────────────────────────────────────────────────
  const total = (shares && price) ? Math.round(shares * price) : null;

  if (!shares && !price && !txDate) return null;

  return { txType, shares, price, total, txDate, dirName };
}

// ── Fetch announcements for one stock code via SPA intercept ──────────────────

async function fetchStockDirDealings(page, stockCode) {
  const items = [];
  const respHandler = async res => {
    const url = res.url();
    if (url.includes('/securitycode?') && url.includes(`value=${stockCode}`)) {
      try {
        const d = JSON.parse(await res.text());
        items.push(...(d.data || []).filter(a => a.sub === 'ANNC14'));
      } catch {}
    }
  };
  page.on('response', respHandler);
  try {
    await page.goto(`${SGX_BASE}?type=securitycode&value=${stockCode}`, {
      waitUntil: 'networkidle0', timeout: 30000,
    });
    await delay(1500);
  } catch {}
  page.off('response', respHandler);
  return items;
}

// ── Fetch filing page, extract HTML metadata + download PDF ───────────────────

async function fetchFilingDetails(page, filingUrl) {
  try {
    await page.goto(filingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText);

    // SGX PDF hrefs are hash-based (e.g. .../889780_FORM) — .pdf only appears in innerText
    const pdfLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const pdf = links.find(a =>
        a.innerText.toLowerCase().includes('.pdf') &&
        a.href.includes('links.sgx.com')
      );
      return pdf ? pdf.href : null;
    });

    return { text, pdfLink };
  } catch {
    return { text: '', pdfLink: null };
  }
}

// ── Download PDF via Puppeteer and convert to text ────────────────────────────

async function downloadPdf(page, url) {
  try {
    const resp = await page.evaluate(async url => {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, url);
    if (!resp) return '';
    const buf = Buffer.from(resp);
    if (buf.slice(0,4).toString() !== '%PDF') return '';
    return await pdfToText(buf);
  } catch { return ''; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeSGDirectorDealings() {
  console.log('🇸🇬  SGX Singapore — Director Dealings (ANNC14)');
  const t0 = Date.now();
  console.log(`  Stocks: ${STOCKS.join(', ')}${TEST_MODE ? ' [TEST MODE]' : ''}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('  Launching browser…');

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH !== '/usr/bin/chromium-browser'
      ? process.env.PUPPETEER_EXECUTABLE_PATH
      : undefined,
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const dbRows = [];
  let totalDir = 0, pdfParsed = 0, metaOnly = 0, skipped = 0;

  for (const stockCode of STOCKS) {
    process.stdout.write(`  ${stockCode} — fetching…`);
    const dirItems = await fetchStockDirDealings(page, stockCode);
    process.stdout.write(` ${dirItems.length} ANNC14`);

    if (dirItems.length === 0) {
      process.stdout.write('\n');
      await delay(DELAY_MS);
      continue;
    }
    totalDir += dirItems.length;

    for (const item of dirItems) {
      const filingId = `SG-${item.id || item.ref_id}`;
      const company  = item.issuer_name || item.issuers?.[0]?.issuer_name || null;
      const ticker   = item.issuers?.[0]?.stock_code || stockCode;
      const isin     = item.issuers?.[0]?.isin_code || null;
      const subDate  = fmtSubDate(item.submission_date);
      const filingUrl = item.url;

      if (!filingUrl) { skipped++; continue; }

      // Director name: try title first (fastest)
      let dirName = extractNameFromTitle(item.title);

      // Transaction details from PDF
      let txType = null, shares = null, price = null, total = null, txDate = subDate;

      // Fetch filing HTML + PDF
      const { text: htmlText, pdfLink } = await fetchFilingDetails(page, filingUrl);
      await delay(300);

      // Try PDF parsing if available
      if (pdfLink) {
        const pdfText = await downloadPdf(page, pdfLink);
        await delay(200);
        if (pdfText) {
          const parsed = parseSGXDirectorPDF(pdfText);
          if (parsed) {
            if (!dirName && parsed.dirName) dirName = parsed.dirName;
            txType  = parsed.txType;
            shares  = parsed.shares;
            price   = parsed.price;
            total   = parsed.total;
            if (parsed.txDate) txDate = parsed.txDate;
            pdfParsed++;
          }
        }
      }

      // Fallback: derive txType from title if PDF didn't give it
      if (!txType) txType = mapTransactionType(item.title);

      // Only save BUY/SELL (skip "OTHER" with no data)
      if (txType === 'OTHER' && !shares) { metaOnly++; continue; }

      const row = {
        filing_id:        filingId,
        country_code:     COUNTRY_CODE,
        ticker,
        company,
        isin,
        insider_name:     dirName,
        insider_role:     null,
        transaction_type: txType,
        transaction_date: txDate,
        shares:           shares,
        price_per_share:  price,
        total_value:      total,
        currency:         CURRENCY,
        filing_url:       filingUrl,
        source:           SOURCE,
        yahoo_ticker:     ticker ? `${ticker}.SI` : null,
      };

      dbRows.push(row);
      if (pdfLink && shares) {
        process.stdout.write('·');
      }

      if (TEST_MODE) {
        console.log(`\n    ${filingId}: ${company} | ${dirName || '(no name)'} | ${txType} | ${shares?.toLocaleString()||'?'} shares @ SGD ${price||'?'}`);
      }
    }
    process.stdout.write('\n');
    await delay(DELAY_MS);
  }

  await browser.close();

  console.log(`\n  Summary: ${totalDir} ANNC14 found | ${pdfParsed} PDF parsed | ${metaOnly} meta-only skipped | ${skipped} no-URL skipped`);
  console.log(`  Rows built: ${dbRows.length}`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save ${dbRows.length} rows`);
    return { saved: 0 };
  }

  // Drop incomplete rows (no shares AND no price) — save only meaningful data
  const meaningful = dbRows.filter(r => r.shares || r.price_per_share);
  const noData     = dbRows.length - meaningful.length;
  if (noData) console.log(`  Dropping ${noData} rows with no shares/price`);

  if (!meaningful.length) { console.log('  Nothing meaningful to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(meaningful);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = meaningful.filter(r => r.transaction_type === 'BUY').length;
  const sells = meaningful.filter(r => r.transaction_type === 'SELL').length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${meaningful.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: meaningful.length };
}

scrapeSGDirectorDealings().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
