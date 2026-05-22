'use strict';
/**
 * SG — Insider Transactions Scraper (Director Dealings)
 *
 * Source: SGX Singapore — api.sgx.com/announcements/v1.1/securitycode
 * Category: ANNC14 = "Disclosure of Interest/ Changes in Interest"
 *
 * Approach: Puppeteer SPA intercept + HTML metadata parsing
 *   1. Navigate to SGX company-announcements for each STI stock
 *   2. Intercept the /securitycode XHR response
 *   3. Filter sub === 'ANNC14'
 *   4. Navigate to each links.sgx.com filing HTML page
 *   5. Extract director name from "Description" field in HTML body
 *   6. Extract transaction type and date from PDF attachment filename
 *   7. Skip compensation events (ADJUST UNVESTED, AWARD, GRANT, VESTING, LAPSE)
 *   8. Save BUY/SELL rows to insider_transactions
 *
 * NOTE: PDFs are AES-encrypted XFA forms (Adobe LiveCycle ES 9.0, copy:no).
 * No tool can extract text from them. All data comes from HTML metadata
 * and the PDF filename. Shares/price fields will be null for SGX rows.
 *
 * Runs daily via run-daily.sh.
 * Use --test to run only first 3 stocks.
 * Use --stocks D05,BN4 to run specific stocks.
 */

const puppeteer                   = require('puppeteer');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE = 'SG';
const CURRENCY     = 'SGD';
const SOURCE       = 'SGX Singapore';
const SGX_BASE     = 'https://www.sgx.com/securities/company-announcements';
const DELAY_MS     = 800;

const STI_STOCKS = [
  'D05','O39','U11','Z74','C6L','S63','G13','F34',
  'N2IU','AJBU','C09','BN4','BS6','C52','H78','J36',
  'J37','M44U','ME8U','S58','T39','U96','V03','W50',
  'Y92','9CI','A17U','S68','U14','T82U',
];

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const TEST_MODE  = args.includes('--test');
const DRY_RUN    = args.includes('--dry-run');
const stocksArg  = args.find(a => a.startsWith('--stocks='));
const stocksFlag = stocksArg ? stocksArg.split('=')[1].split(',') : null;
const lookbackDays = parseInt(process.env.LOOKBACK_DAYS || '14', 10);

const STOCKS = stocksFlag
  ? STI_STOCKS.filter(s => stocksFlag.includes(s))
  : TEST_MODE
    ? STI_STOCKS.slice(0, 3)
    : STI_STOCKS;

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** submission_date YYYYMMDD → YYYY-MM-DD */
function fmtSubDate(s) {
  if (!s || s.length < 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

const MONTH_MAP = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
  jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

/** Parse "15May26" from PDF filename → "2026-05-15" */
function parseDateFromFilename(filename) {
  const m = filename.match(/(\d{1,2})([A-Za-z]{3})(\d{2})/);
  if (!m) return null;
  const day   = m[1].padStart(2, '0');
  const month = MONTH_MAP[m[2].toLowerCase()];
  if (!month) return null;
  const year  = 2000 + parseInt(m[3], 10);
  return `${year}-${String(month).padStart(2, '0')}-${day}`;
}

/**
 * Classify a PDF attachment filename as BUY, SELL, or SKIP.
 * Returns null if type cannot be determined from filename alone.
 *
 * Skip patterns: compensation events that are not open-market transactions
 *   ADJUST UNVESTED / UNVESTED / AWARD / GRANT / VEST / LAPSE / BONUS /
 *   INITIAL (first-time disclosure) / DEEMED / CONVERSION / DEEMED
 */
function classifyFilename(filename) {
  const f = (filename || '').toUpperCase();
  if (/ADJUST|UNVESTED|AWARD|GRANT|VEST(?:ING)?|LAPSE|BONUS|INITIAL|DEEMED|CONVER/.test(f)) return 'SKIP';
  if (/SALE|DISPOS/.test(f)) return 'SELL';
  if (/BUY|ACQUI|PURCH/.test(f)) return 'BUY';
  return null;
}

/**
 * Extract director name and PDF filename from the SGX filing HTML body text.
 *
 * The HTML body consistently contains:
 *   Description (Please provide a detailed description…)
 *   Disclosure of director's interest - Tan Su Shan
 *   Additional Details
 *   …
 *   Attachments
 *   FORM1_TSS_15May26_SALE_FINAL.pdf
 */
function parseFilingHtml(bodyText) {
  let dirName     = null;
  let pdfFilename = null;

  // Director name from Description field
  // "Disclosure of director's interest - Tan Su Shan"
  // "Change in interest - Peter Tan"
  // "Disclosure of Interest of Director - Wong Kan Seng"
  const nameM = bodyText.match(
    /(?:Disclosure of (?:director(?:'s)?|interest)|Change in (?:director(?:'s)?\s+)?interest)[^\n]*?[-–]\s*([A-Z][^\n]{2,70}?)(?:\r?\n|Additional)/i
  );
  if (nameM) {
    dirName = nameM[1].trim().replace(/\s{2,}/g, ' ').slice(0, 80);
    // Reject if it looks like boilerplate text
    if (/^(?:a\s+)?Director|^Interest|^Chief|^CEO|^New|^Change|^Notice|^Disclos/i.test(dirName)) {
      dirName = null;
    }
  }

  // PDF filename from Attachments section — first attachment (not starting with _)
  const attachM = bodyText.match(/Attachments\s*\r?\n([^\n_][^\n]*\.pdf)/i);
  if (attachM) {
    pdfFilename = attachM[1].trim();
  }

  return { dirName, pdfFilename };
}

/** Extract director name from filing title after "::" */
function extractNameFromTitle(title) {
  if (!title) return null;
  const after = (title.split('::')[1] || '').trim();
  const cleaned = after
    .replace(/^Disclosure of Interest of a Director\s*[-–]\s*/i, '')
    .replace(/^Change in Interest of\s*/i, '')
    .replace(/^Disclosure of(?:\s+(?:initial|substantial|direct))?\s+(?:a\s+)?(?:director(?:'s)?|interest)\s*[-–]?\s*/i, '')
    .replace(/^Notice of change in interests of Director\s*/i, '')
    .trim();
  if (cleaned.length < 4 || /^(new|initial|annual|change|notice|disclosure|substantial|interest)/i.test(cleaned)) return null;
  if (!/[A-Z]/.test(cleaned.slice(0, 2))) return null;
  return cleaned.slice(0, 80) || null;
}

// ── Fetch announcements for one stock via SPA intercept ───────────────────────

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

// ── Fetch filing HTML and extract metadata ────────────────────────────────────

async function fetchFilingHtml(page, filingUrl) {
  try {
    await page.goto(filingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    return bodyText;
  } catch {
    return '';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeSGDirectorDealings() {
  console.log('🇸🇬  SGX Singapore — Director Dealings (ANNC14)');
  const t0 = Date.now();
  console.log(`  Stocks: ${STOCKS.join(', ')}${TEST_MODE ? ' [TEST MODE]' : ''}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`  Lookback: ${lookbackDays} days`);
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

  // Cutoff date for lookback filter
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  const dbRows = [];
  let totalAnnc = 0, savedCount = 0, skippedComp = 0, skippedUnknown = 0, skippedOld = 0;

  for (const stockCode of STOCKS) {
    process.stdout.write(`  ${stockCode} — fetching…`);
    const dirItems = await fetchStockDirDealings(page, stockCode);
    process.stdout.write(` ${dirItems.length} ANNC14`);

    if (dirItems.length === 0) {
      process.stdout.write('\n');
      await delay(DELAY_MS);
      continue;
    }
    totalAnnc += dirItems.length;

    for (const item of dirItems) {
      const subDate   = fmtSubDate(item.submission_date);
      const filingId  = `SG-${item.id || item.ref_id}`;
      const company   = item.issuer_name || item.issuers?.[0]?.issuer_name || null;
      const ticker    = item.issuers?.[0]?.stock_code || stockCode;
      const isin      = item.issuers?.[0]?.isin_code || null;
      const filingUrl = item.url;

      if (!filingUrl) continue;

      // Lookback filter
      if (subDate && subDate < cutoffStr) { skippedOld++; continue; }

      // Director name: try title first
      let dirName = extractNameFromTitle(item.title);

      // Fetch HTML body for description + attachment filename
      const bodyText = await fetchFilingHtml(page, filingUrl);
      await delay(300);

      const { dirName: htmlDirName, pdfFilename } = parseFilingHtml(bodyText);
      if (!dirName && htmlDirName) dirName = htmlDirName;

      // Classify via PDF filename (most reliable signal)
      const filenameType = pdfFilename ? classifyFilename(pdfFilename) : null;
      const filenameDate = pdfFilename ? parseDateFromFilename(pdfFilename) : null;

      // Skip compensation/administrative events
      if (filenameType === 'SKIP') { skippedComp++; continue; }

      // Transaction type: filename > title fallback
      let txType = filenameType;
      if (!txType) {
        const titleLow = (item.title || '').toLowerCase();
        if (/acqui|purchase|bought/i.test(titleLow)) txType = 'BUY';
        else if (/dispos|sale|sold/i.test(titleLow)) txType = 'SELL';
        else { skippedUnknown++; continue; }  // can't determine type, skip
      }

      // Transaction date: filename date is more accurate than filing date
      const txDate = filenameDate || subDate;

      const row = {
        filing_id:        filingId,
        country_code:     COUNTRY_CODE,
        ticker,
        company,
        insider_name:     dirName,
        insider_role:     null,
        transaction_type: txType,
        transaction_date: txDate,
        shares:           null,  // AES-encrypted PDF, cannot extract
        price_per_share:  null,
        total_value:      null,
        currency:         CURRENCY,
        filing_url:       filingUrl,
        source:           SOURCE,
      };

      dbRows.push(row);
      savedCount++;

      if (TEST_MODE) {
        console.log(`\n    ${filingId}: ${company} | ${dirName || '(no name)'} | ${txType} | date: ${txDate}`);
        if (pdfFilename) console.log(`    PDF: ${pdfFilename}`);
      }
    }

    process.stdout.write(` → ${savedCount} built so far\n`);
    await delay(DELAY_MS);
  }

  await browser.close();

  console.log(`\n  Summary: ${totalAnnc} ANNC14 | ${savedCount} BUY/SELL rows | ${skippedComp} comp/admin skipped | ${skippedUnknown} unknown-type skipped | ${skippedOld} too old`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save ${dbRows.length} rows`);
    dbRows.slice(0, 5).forEach(r =>
      console.log(`    ${r.company} | ${r.insider_name||'(no name)'} | ${r.transaction_type} | ${r.transaction_date}`)
    );
    return { saved: 0 };
  }

  // allowPartial: SGX PDFs are AES-encrypted; shares/price cannot be extracted
  const { error, inserted } = await saveInsiderTransactions(dbRows, { allowPartial: true });
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  const actualSaved = inserted ?? dbRows.length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${actualSaved} saved (${buys} BUY, ${sells} SELL)`);
  if (dbRows.length > 0) {
    console.log('  Sample:', dbRows.slice(0, 3).map(r =>
      `${r.company}: ${r.insider_name||'?'} ${r.transaction_type} (${r.transaction_date})`
    ).join(' | '));
  }
  return { saved: actualSaved ?? 0 };
}

scrapeSGDirectorDealings().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
