'use strict';
/**
 * SG — Share Buyback Scraper (Phase 1)
 *
 * Source: SGX Singapore — api.sgx.com/announcements/v1.1/securitycode
 * Category: ANNC13 = "Share Buy Back-On Market" (Daily Share Buy-Back Notice)
 *
 * Approach: Puppeteer SPA intercept
 *   1. Navigate to SGX company-announcements for each STI stock
 *   2. Intercept the /securitycode XHR response (20 most recent items)
 *   3. Filter sub === 'ANNC13'
 *   4. Navigate to each filing URL (links.sgx.com HTML — fully structured)
 *   5. Parse HTML table for shares, price, total consideration, cumulative
 *
 * SGX filing HTML fields (parsed via innerText):
 *   - Start date for mandate → announced_date
 *   - Maximum number of shares authorised → program share cap
 *   - Date of Purchase → execution_date
 *   - Total Number of shares purchased → shares_bought
 *   - Highest/Lowest Price per share OR Price Paid per share → avg_price
 *   - Total Consideration → spent_value (execution)
 *   - Cumulative by way of Market Acquisition → cumulative_shares + completion_pct
 *
 * Runs weekly (buybacks-weekly.yml).
 * Use --test to run only first 3 stocks (D05, O39, U11).
 * Use --stocks D05,BN4 to run specific stocks.
 */

const puppeteer          = require('puppeteer');
const { saveBuybackPrograms } = require('../lib/db');

const COUNTRY_CODE = 'SG';
const CURRENCY     = 'SGD';
const SOURCE       = 'SGX Singapore';
const SGX_BASE     = 'https://www.sgx.com/securities/company-announcements';
const DELAY_MS     = 800;   // between stock navigations

// STI 30 component stock codes
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

/** Parse SGD amount: "4,166,824.89" → 4166824.89 */
function parseSgd(s) {
  if (!s) return null;
  return parseFloat(s.replace(/,/g, '')) || null;
}

/** Parse share count: "400,000" → 400000 */
function parseShares(s) {
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Convert DD/MM/YYYY → YYYY-MM-DD */
function sgxDateToIso(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── Parse SGX buyback filing HTML ──────────────────────────────────────────────

function parseSGXBuybackPage(rawText, fallbackDate) {
  // Normalise: collapse multiple tabs/spaces to single \t; keep newlines
  const text = rawText.replace(/\t+/g, '\t').replace(/[ ]{3,}/g, ' ');

  // ── Mandate start ─────────────────────────────────────────────────────────
  const mandateM = text.match(/Start date for mandate[^\n]*[\n\t]+(\d{2}\/\d{2}\/\d{4})/i);
  const mandateStart = mandateM ? sgxDateToIso(mandateM[1]) : null;

  // ── Max shares authorised ─────────────────────────────────────────────────
  const maxM = text.match(/Maximum number of shares authorised for purchase[\n\t]+([\d,]+)/i);
  const maxShares = maxM ? parseShares(maxM[1]) : null;

  // ── Date of purchase ──────────────────────────────────────────────────────
  const purchM = text.match(/Date of Purchase[\t ]+(\d{2}\/\d{2}\/\d{4})/i);
  const purchaseDate = purchM ? sgxDateToIso(purchM[1]) : fallbackDate;

  // ── Shares purchased ──────────────────────────────────────────────────────
  const sharesM = text.match(/Total Number of shares purchased[\t ]+([\d,]+)/i);
  const sharesPurchased = sharesM ? parseShares(sharesM[1]) : null;

  // ── Price (high/low or single) ────────────────────────────────────────────
  const highM  = text.match(/Highest Price per share[\t ]+SGD\s*([\d,.]+)/i);
  const lowM   = text.match(/Lowest Price per share[\t ]+SGD\s*([\d,.]+)/i);
  const singleM = text.match(/Price Paid per share[\t ]+SGD\s*([\d,.]+)/i);

  const priceHigh = highM  ? parseSgd(highM[1])  : (singleM ? parseSgd(singleM[1]) : null);
  const priceLow  = lowM   ? parseSgd(lowM[1])   : (singleM ? parseSgd(singleM[1]) : null);
  const avgPrice  = (priceHigh != null && priceLow != null)
    ? Math.round((priceHigh + priceLow) / 2 * 10000) / 10000
    : (priceHigh ?? priceLow ?? null);

  // ── Total consideration (this execution) ──────────────────────────────────
  // "Total Consideration (including stamp duties...) ... SGD 4,166,824.89"
  const totalM = text.match(/Total Consideration[^\n]*[\t ]+SGD\s*([\d,.]+)/i)
               || text.match(/Total Consideration[^S]*SGD\s*([\d,.]+)/i);
  const totalConsideration = totalM
    ? parseSgd(totalM[1])
    : (sharesPurchased && avgPrice ? Math.round(sharesPurchased * avgPrice) : null);

  // ── Cumulative (market acquisition) ──────────────────────────────────────
  // "By way of Market Acquisition\t499,200\t0.047"
  const cumM = text.match(/By way of Market Acquisition[\t ]+([\d,]+)[\t ]+([\d.]+)/i);
  const cumulativeShares = cumM ? parseShares(cumM[1]) : null;

  // ── Completion % ─────────────────────────────────────────────────────────
  let completionPct = cumM ? parseFloat(cumM[2]) : null;
  if (completionPct == null && maxShares && cumulativeShares) {
    completionPct = Math.round(cumulativeShares / maxShares * 1000) / 10;
  }

  return {
    mandateStart,
    maxShares,
    purchaseDate,
    sharesPurchased,
    priceHigh,
    priceLow,
    avgPrice,
    totalConsideration,
    cumulativeShares,
    completionPct,
  };
}

// ── Fetch announcements for one stock code via Puppeteer SPA intercept ─────────

async function fetchStockBuybacks(page, stockCode) {
  const items = [];

  const respHandler = async res => {
    const url = res.url();
    if (url.includes('/securitycode?') && url.includes(`value=${stockCode}`)) {
      try {
        const d = JSON.parse(await res.text());
        const buy13 = (d.data || []).filter(a => a.sub === 'ANNC13');
        items.push(...buy13);
      } catch {}
    }
  };

  page.on('response', respHandler);
  try {
    await page.goto(`${SGX_BASE}?type=securitycode&value=${stockCode}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });
    await delay(1500);
  } catch (e) {
    // timeout is ok — we may still have captured the XHR
  }
  page.off('response', respHandler);
  return items;
}

// ── Fetch and parse one filing page ───────────────────────────────────────────

async function fetchFilingData(page, url, fallbackDate) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    return parseSGXBuybackPage(text, fallbackDate);
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeSGBuybacks() {
  console.log('🇸🇬  SGX Singapore — Share Buyback Programs (ANNC13)');
  const t0 = Date.now();
  console.log(`  Stocks: ${STOCKS.join(', ')}${TEST_MODE ? ' [TEST MODE]' : ''}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('  Launching browser…');

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH !== '/usr/bin/chromium-browser'
      ? process.env.PUPPETEER_EXECUTABLE_PATH
      : undefined,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  const dbRows = [];
  let totalBuybacks = 0, parsed = 0, skipped = 0;

  for (const stockCode of STOCKS) {
    process.stdout.write(`  ${stockCode} — fetching announcements…`);
    const buybackItems = await fetchStockBuybacks(page, stockCode);
    process.stdout.write(` ${buybackItems.length} buyback filing(s)`);

    if (buybackItems.length === 0) {
      process.stdout.write('\n');
      await delay(DELAY_MS);
      continue;
    }

    totalBuybacks += buybackItems.length;
    let stockParsed = 0;

    for (const item of buybackItems) {
      const filingId   = `SG-BUY-${item.id}`;
      const company    = item.issuer_name || item.issuers?.[0]?.issuer_name || null;
      const ticker     = item.issuers?.[0]?.stock_code || stockCode;
      const isin       = item.issuers?.[0]?.isin_code || null;
      const subDate    = item.submission_date        // YYYYMMDD
        ? `${item.submission_date.slice(0,4)}-${item.submission_date.slice(4,6)}-${item.submission_date.slice(6,8)}`
        : null;

      const filingUrl = item.url;
      if (!filingUrl) { skipped++; continue; }

      const parsed_data = await fetchFilingData(page, filingUrl, subDate);
      await delay(400);

      if (!parsed_data?.sharesPurchased) { skipped++; continue; }

      const row = {
        filing_id:         filingId,
        country_code:      COUNTRY_CODE,
        ticker,
        company,
        currency:          CURRENCY,
        source:            SOURCE,
        filing_url:        filingUrl,
        status:            parsed_data.completionPct >= 95 ? 'Completed' : 'Active',

        // Program-level fields (announced_date = mandate start)
        announced_date:    parsed_data.mandateStart || subDate,

        // This execution
        execution_date:    parsed_data.purchaseDate || subDate,
        shares_bought:     parsed_data.sharesPurchased,
        avg_price:         parsed_data.avgPrice,
        spent_value:       parsed_data.totalConsideration ? Math.round(parsed_data.totalConsideration) : null,

        // Cumulative
        cumulative_shares: parsed_data.cumulativeShares,
        completion_pct:    parsed_data.completionPct,
        pct_complete:      parsed_data.completionPct != null
          ? Math.round(parsed_data.completionPct) : null,
      };

      // total_value: SGX authorises in shares, not value — leave null
      // If we have maxShares × price we could estimate but it's misleading
      row.total_value = null;

      stockParsed++;
      dbRows.push(row);

      if (TEST_MODE) {
        console.log(`\n    Filing: ${filingId}`);
        console.log(`    Company: ${company} | Date: ${row.execution_date}`);
        console.log(`    Shares: ${row.shares_bought?.toLocaleString()} @ SGD ${row.avg_price}`);
        console.log(`    Total: SGD ${row.spent_value?.toLocaleString()}`);
        console.log(`    Cumulative: ${row.cumulative_shares?.toLocaleString()} (${row.completion_pct}%)`);
        console.log(`    Mandate start: ${row.announced_date}`);
      }
    }

    parsed += stockParsed;
    process.stdout.write(` → ${stockParsed} rows built\n`);
    await delay(DELAY_MS);
  }

  await browser.close();

  console.log(`\n  Summary: ${totalBuybacks} ANNC13 filings found, ${parsed} parsed, ${skipped} skipped`);

  if (!dbRows.length) {
    console.log('  Nothing to save.');
    return { saved: 0 };
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save ${dbRows.length} rows to buyback_programs`);
    return { saved: 0 };
  }

  const { error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${dbRows.length} rows saved to buyback_programs`);
  if (dbRows.length > 0) {
    console.log('  Sample:', dbRows.slice(0,2).map(r =>
      `${r.company}: ${r.shares_bought?.toLocaleString()} shares @ SGD ${r.avg_price} (${r.completion_pct}%)`
    ).join('; '));
  }
  return { saved: dbRows.length };
}

scrapeSGBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
