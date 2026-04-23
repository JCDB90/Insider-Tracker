/**
 * CA — Insider Transactions Scraper
 *
 * Source: SEDI (System for Electronic Disclosure by Insiders)
 *         Canadian Securities Administrators (CSA)
 * URL: https://www.sedi.ca/
 *
 * SEDI is protected by ShieldSquare/PerformDrive bot detection.  Plain HTTP
 * requests and even headless Chrome are blocked after a couple of pages.
 * Strategy: puppeteer-extra + stealth plugin to emulate a full browser session,
 * then navigate the multi-step SEDI public-filing search with human-like delays.
 *
 * On GitHub Actions (fresh Azure IP per run) the first few requests pass
 * ShieldSquare before behavioral analysis triggers.  On local datacenter IPs
 * the welcome page itself may be blocked after prior scraping runs.
 *
 * Navigation flow (3 pages → one form POST):
 *   1. /sedi/SVTWelcome            — get session cookies
 *   2. /sedi/SVTAccessPublicFiling — navigate to public-filing menu
 *   3. /sedi/SVTReportsAccessController — reports menu
 *   4. Click "Insider Transactions" link → date-range form
 *   5. Submit form → parse HTML table
 *
 * Table columns returned by SEDI:
 *   Issuer Name | Insider Name | Transaction Date | Nature of Transaction |
 *   Number of Securities | Average Price | Total Value | Security Designation
 */
'use strict';

const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'CA';
const SOURCE         = 'SEDI Canada';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'CAD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// SEDI uses DD/MM/YYYY for date inputs
function sediDate(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── Parse SEDI HTML transaction table ────────────────────────────────────────

function parseSediTable(html) {
  // Extract <tr> rows from the transaction results table
  const rows = [];
  const tableMatch = html.match(/<table[^>]*class="[^"]*data[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
                  || html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return rows;

  const trMatches = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  // Skip header row (th cells)
  const dataRows = trMatches.filter(m => !m[1].includes('<th'));

  for (const tr of dataRows) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());

    if (cells.length < 5) continue;

    // Expected order: Issuer | Insider | Date | Nature | Securities | Price | Total | Security type
    const [company, insiderName, txDateRaw, natureTx, sharesRaw, priceRaw, totalRaw] = cells;

    // Parse date DD/MM/YYYY or YYYY-MM-DD
    let txDate = null;
    if (txDateRaw) {
      const m = txDateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) txDate = `${m[3]}-${m[2]}-${m[1]}`;
      else if (/\d{4}-\d{2}-\d{2}/.test(txDateRaw)) txDate = txDateRaw.slice(0, 10);
    }

    const txType = (() => {
      const n = (natureTx || '').toLowerCase();
      if (n.includes('acqui') || n.includes('purchase') || n.includes('exercise') || n.includes('grant')) return 'BUY';
      if (n.includes('dispos') || n.includes('sale') || n.includes('transfer')) return 'SELL';
      return 'OTHER';
    })();

    function parseNum(s) {
      if (!s) return null;
      const n = parseFloat(s.replace(/[,$\s]/g, ''));
      return isNaN(n) ? null : n;
    }

    const shares = sharesRaw ? Math.round(Math.abs(parseNum(sharesRaw) || 0)) || null : null;
    const price  = parseNum(priceRaw);
    const total  = totalRaw ? Math.round(Math.abs(parseNum(totalRaw) || 0)) || null : null;

    if (!company && !insiderName) continue;

    rows.push({ company, insiderName, txDate, txType, shares, price, total });
  }
  return rows;
}

// ─── Puppeteer stealth scraper ─────────────────────────────────────────────────

async function fetchViaSedi(fromDate, toDate) {
  let puppeteer, StealthPlugin;
  try {
    puppeteer     = require('puppeteer-extra');
    StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
  } catch {
    console.log('  ⚠  puppeteer-extra / stealth not installed.');
    return null;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  function isBlocked(url) {
    return url.includes('perfdrive.com') || url.includes('shieldsquare.com') || url.includes('validate.');
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-CA,en;q=0.9' });

    // ── Step 1: Welcome page ──────────────────────────────────────────────────
    console.log('  [1/4] Loading SEDI welcome page…');
    await page.goto('https://www.sedi.ca/sedi/SVTWelcome?locale=en_ca&pageName=splashPage', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    if (isBlocked(page.url())) {
      console.log('  ⚠  Blocked at welcome page (IP flagged by ShieldSquare).');
      return null;
    }

    // ── Step 2: Public filing menu ────────────────────────────────────────────
    console.log('  [2/4] Navigating to public filings…');
    await page.goto('https://www.sedi.ca/sedi/SVTAccessPublicFiling?menukey=15.00.00&gx_session=0&locale=en_CA', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    if (isBlocked(page.url())) {
      console.log('  ⚠  Blocked at public filings page.');
      return null;
    }

    // ── Step 3: Reports menu ──────────────────────────────────────────────────
    console.log('  [3/4] Navigating to reports…');
    await page.goto('https://www.sedi.ca/sedi/SVTReportsAccessController?menukey=15.03.00&locale=en_CA&gx_session=0', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    if (isBlocked(page.url())) {
      console.log('  ⚠  Blocked at reports page (ShieldSquare behavioral block).');
      console.log('  ℹ  Works best on GitHub Actions EU/NA runners with fresh IPs.');
      return null;
    }

    // Find insider transactions report link
    const insiderLink = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')];
      const match = links.find(a => /insider.*(transaction|trade)/i.test(a.innerText));
      return match ? match.href : null;
    });

    if (!insiderLink) {
      console.log('  ⚠  Could not find insider transactions report link on SEDI reports page.');
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('  Page text:', text);
      return null;
    }

    // ── Step 4: Navigate to insider transactions, fill date form ──────────────
    console.log('  [4/4] Submitting date-range search…');
    await page.goto(insiderLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    if (isBlocked(page.url())) {
      console.log('  ⚠  Blocked at insider transactions form.');
      return null;
    }

    // Fill date range fields (SEDI uses DD/MM/YYYY format)
    const fromSedi = sediDate(new Date(fromDate));
    const toSedi   = sediDate(new Date(toDate));

    // Try to fill and submit the date form
    const submitted = await page.evaluate((from, to) => {
      // Look for date fields
      const inputs = [...document.querySelectorAll('input[type="text"],input[type="date"]')];
      const fromField = inputs.find(i => /from|start|begin|de/i.test(i.name + i.id + i.placeholder));
      const toField   = inputs.find(i => /to$|end|fin/i.test(i.name + i.id + i.placeholder));

      if (fromField) fromField.value = from;
      if (toField)   toField.value   = to;

      const form = document.querySelector('form');
      if (!form) return false;

      // Submit
      const submitBtn = form.querySelector('input[type="submit"],button[type="submit"]');
      if (submitBtn) { submitBtn.click(); return true; }
      form.submit();
      return true;
    }, fromSedi, toSedi);

    if (!submitted) {
      console.log('  ⚠  Could not submit search form.');
      return null;
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    if (isBlocked(page.url())) {
      console.log('  ⚠  Blocked after form submission.');
      return null;
    }

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeCA() {
  console.log('🇨🇦  SEDI Canada — insider transactions (via stealth browser)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const html = await fetchViaSedi(from, to);

  if (!html) {
    console.log('  ⚠  SEDI did not return usable data (ShieldSquare block or navigation failure).');
    console.log('  ℹ  Portal: https://www.sedi.ca/');
    console.log('  ℹ  This scraper uses puppeteer-extra + stealth; works best on GitHub Actions runners.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const items = parseSediTable(html);
  if (!items.length) {
    console.log('  ⚠  No table rows parsed from SEDI response.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }
  console.log(`  Parsed ${items.length} transactions from SEDI`);

  const seen   = new Set();
  const dbRows = [];

  for (const r of items) {
    const fid = `CA-${(r.company || 'X').replace(/\s+/g,'-').slice(0,20)}-${(r.insiderName || 'X').replace(/\s+/g,'-').slice(0,20)}-${r.txDate || from}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           null,
      company:          r.company  || null,
      insider_name:     r.insiderName || null,
      insider_role:     null,
      transaction_type: r.txType,
      transaction_date: r.txDate || from,
      shares:           r.shares,
      price_per_share:  r.price,
      total_value:      r.total,
      currency:         CURRENCY,
      filing_url:       'https://www.sedi.ca/sedi/SVTAccessPublicFiling?menukey=15.00.00&locale=en_CA',
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} @ ${r.price_per_share} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeCA().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
