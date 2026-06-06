/**
 * Sweden (SE) — Insider Transactions Scraper
 *
 * Source: Finansinspektionen (FI) — Insynsregistret
 * URL: https://marknadssok.fi.se/Publiceringsklient/en-GB/Search/Search
 *
 * Strategy: Puppeteer-based CSV export.
 *   FI blocks raw HTTP requests from datacenter IPs (Hetzner, Azure) after
 *   ~7 requests. Puppeteer's real browser fingerprint bypasses this block.
 *
 *   Flow:
 *   1. Launch headless Chrome; navigate to FI search page (passes bot-detection)
 *   2. page.screenshot → /tmp/fi-debug.png for diagnostics
 *   3. Promise.all([page.waitForResponse(csv), page.evaluate(exportBtn.click())])
 *   4. waitForResponse captures the UTF-16 LE CSV bytes
 *   5. Parse and save (one request = all rows, no pagination)
 *
 * CSV columns (0-indexed):
 *   [0]  Publication date      [1]  Issuer (company)
 *   [2]  LEI-code              [3]  Notifier
 *   [4]  Person discharging managerial responsibilities
 *   [5]  Position              [6]  Closely associated (Yes/empty)
 *   [11] Nature of transaction [12] Instrument type
 *   [14] ISIN                  [15] Transaction date
 *   [16] Volume                [18] Price     [19] Currency
 */
'use strict';

const puppeteer = require('puppeteer');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');
const { isinToTicker }           = require('./lib/isinToTicker');
const { contentId }              = require('./lib/contentId');
const { looksLikeCorp }          = require('./lib/entityUtils');

const COUNTRY_CODE   = 'SE';
const SOURCE         = 'Finansinspektionen Sweden';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const BASE           = 'https://marknadssok.fi.se/Publiceringsklient/en-GB/Search/Search';
const HEADERS        = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// CSV date format: "04/06/2026 00:00:00" (DD/MM/YYYY HH:MM:SS)
function parseFIDate(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const dt = new Date(`${m[3]}-${m[2]}-${m[1]}`);
  return isNaN(dt.getTime()) ? null : dt;
}

function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function parseNum(s) {
  if (!s || s.trim() === '-' || s.trim() === '') return null;
  const str = s.trim().replace(/\s/g, '');
  if (!str) return null;
  if (/\d\.\d{3},/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(?:\.\d{3})+$/.test(str)) return parseFloat(str.replace(/\./g, ''));
  if (/^\d{1,3}(?:,\d{3}){2,}$/.test(str)) return parseFloat(str.replace(/,/g, ''));
  if (/,/.test(str) && !/\./.test(str)) return parseFloat(str.replace(',', '.'));
  return parseFloat(str.replace(/,/g, ''));
}

function parseShares(s) {
  if (!s) return null;
  // CSV volume is like "231351.0" or "2164.0" — strip decimal
  const n = parseFloat(String(s).trim().replace(/[^\d.]/g, ''));
  return isNaN(n) || n === 0 ? null : Math.round(n);
}

function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('subscript') || l.includes('grant') ||
      l.includes('purchas') || l.includes('receiv') || l.includes('gift') ||
      l.includes('award') || l.includes('exercis') || l.includes('convert') ||
      l.includes('inherit') || l.includes('allotm')) return 'BUY';
  if (l.includes('dispos') || l.includes('sale') || l.includes('redem') ||
      l.includes('divest')) return 'SELL';
  return 'OTHER';
}

const TICKERS = {
  'evolution': 'EVO', 'hexagon': 'HEXA-B', 'ericsson': 'ERIC-B',
  'betsson': 'BETS-B', 'kindred': 'KIND-SDB', 'i-tech': 'ITECH',
  'volvo cars': 'VOLCAR-B', 'volvo': 'VOLV-B',
  'abb': 'ABB', 'atlas copco': 'ATCO-A', 'investor': 'INVE-B',
  'essity': 'ESSITY-B', 'sandvik': 'SAND',
  'handelsbanken': 'SHB-A', 'swedbank': 'SWED-A',
  'seb ': 'SEB-A',
  'nordea': 'NDA-SE', 'alfa laval': 'ALFA', 'nibe': 'NIBE-B',
  'sinch': 'SINCH', 'tele2': 'TEL2-B', 'telia': 'TELIA',
  'boliden': 'BOL', 'h&m': 'HM-B', 'hennes & mauritz': 'HM-B',
  'autoliv': 'ALIV-SDB', 'elekta': 'EKTA-B',
  'getinge': 'GETI-B', 'ssab': 'SSAB-A',
  'husqvarna': 'HUSQ-B', 'skanska': 'SKA-B',
  'electrolux': 'ELUX-B',
  'kinnevik': 'KINV-B',
  'industrivärden': 'INDU-C', 'industrivarden': 'INDU-C',
  'lifco': 'LIFCO-B',
  'saab': 'SAAB-B',
  'castellum': 'CAST',
  'fastighets': 'FASTU-B',
  'fingerprint': 'FING-B',
  'midsona': 'MIDS-B',
  'nyfosa': 'NYF',
  'epiroc': 'EPI-B',
  'viaplay': 'VPLAY-B',
  'elanders': 'ELAN-B',
  'hexpol': 'HEXPOL-B',
  'lundbergs': 'LUND-B',
  'latour': 'LATO-B',
  'ica gruppen': 'ICA',
  'addtech': 'ADDT-B',
  'addnode': 'ADDN-B',
  'bilia': 'BILI-A',
  'thule': 'THULE',
  'nolato': 'NOLA-B',
  'troax': 'TROAX',
  'vitec': 'VIT-B',
  'indutrade': 'INDT',
  'dometic': 'DOM',
  'eeducation albert': 'ALBER',
  'medicover': 'MCOV-B',
  'avanza bank': 'AZA',
  'avanza': 'AZA',
  'scandic hotels': 'SCST',
  'diös fastigheter': 'DIOS',
  'dios fastigheter': 'DIOS',
  'cellavision': 'CEVI',
  'fabege': 'FABG',
  'bonava': 'BONA-B',
  'platzer fastigheter': 'PLAZ',
  'swedencare': 'SWED-B',
  'humana ab': 'HUMA',
  'nordnet': 'NORDNET',
  'flowscape': 'FLOW-B',
  'greater than': 'GREAT',
  'lindab': 'LIAB',
  'alleima': 'ALLEI',
  'proact it': 'PACT',
  'proact': 'PACT',
  'nederman': 'NMAN',
  'fagerhult': 'FAG',
  'ework group': 'EWRK',
  'ework': 'EWRK',
  'invisio': 'IVSO',
  'bonesupport': 'BONEX',
  'teqnion': 'TEQ',
  'pandox': 'PNDX-B',
  'samhällsbyggnadsbolaget': 'SBB-B',
  'samhallsbyggnadsbolaget': 'SBB-B',
  'addlife': 'ALIF-B',
  'add life': 'ALIF-B',
  'assa abloy': 'ASSA-B',
  'ncc ': 'NCC-B',
  'securitas': 'SECU-B',
  'billerud': 'BILL',
  'sweco': 'SWEC-B',
  'trelleborg': 'TREL-B',
  'truecaller': 'TRUE-B',
  'wallenstam': 'WALL-B',
  'storytel': 'STORY-B',
  'dustin': 'DUST',
  'holmen': 'HOLM-B',
  'rejlers': 'REJL-B',
  'ratos': 'RATO-B',
  'nobia': 'NOBI',
  'logistea': 'LOGIST-B',
  'knowit': 'KNOW',
  'bergman & beving': 'BERG-B',
  'investment aktiebolaget spiltan': 'SPILTAN',
};

function getTicker(n) {
  if (!n) return null;
  const l = n.toLowerCase();
  for (const [k, v] of Object.entries(TICKERS)) if (l.includes(k)) return v;
  const clean = n
    .replace(/^AB\s+/i, '')
    .replace(/\s+AB(?:\s+\(publ\))?\.?\s*$/i, '')
    .trim();
  return clean.split(/\s+/)[0].toUpperCase().slice(0, 6) || null;
}

// ─── Chromium path resolution (mirrors portugal.js) ──────────────────────────

function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  const { execSync } = require('child_process');
  for (const p of candidates) {
    try { execSync(`test -x ${p}`, { stdio: 'ignore' }); return p; } catch {}
  }
  try { return puppeteer.executablePath(); } catch {}
  return undefined;
}

// ─── CSV export via Puppeteer ─────────────────────────────────────────────────

async function fetchCsv(from, to) {
  const searchUrl = `${BASE}?SearchFunctionType=Insyn` +
    `&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}`;

  const chromiumPath = findChromium();
  console.log(`  Using Chromium: ${chromiumPath || '(puppeteer default)'}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });

  let buf;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': HEADERS['Accept-Language'] });

    // Step 1: visit the search page so FI's session/bot-detection is satisfied
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Debug screenshot to diagnose page state before export
    await page.screenshot({ path: '/tmp/fi-debug.png' });
    console.log('  Debug screenshot saved to /tmp/fi-debug.png');

    // Step 2: click the export button and intercept the CSV response in parallel.
    // waitForResponse is more reliable than page.on('response') + manual timer.
    const [response] = await Promise.all([
      page.waitForResponse(
        r => r.url().includes('Search') &&
             ((r.headers()['content-type'] || '').includes('csv') ||
              r.url().includes('button=export')),
        { timeout: 60000 }
      ),
      page.evaluate(() => {
        const btn = document.querySelector('button[value="export"]') ||
                    document.querySelector('input[name="button"]');
        if (btn) btn.click();
      }),
    ]);

    buf = await response.buffer();
  } finally {
    await browser.close();
  }

  const text = buf.toString('utf16le');  // Node.js spelling (no hyphens)
  const lines = text.split('\n').map(l => l.replace(/\r$/, '').trim()).filter(Boolean);

  if (lines.length < 2) return [];

  // Skip header row (line 0)
  return lines.slice(1).map(line => {
    const c = line.split(';');
    return {
      publicationDate:   c[0]?.trim()  || null,
      company:           c[1]?.trim()  || null,
      lei:               c[2]?.trim()  || null,
      notifier:          c[3]?.trim()  || null,
      insider:           c[4]?.trim()  || null,   // Person discharging mgmt responsibilities
      position:          c[5]?.trim()  || null,
      closelyAssociated: c[6]?.trim()  || null,   // "Yes" or empty
      nature:            c[11]?.trim() || null,   // "Acquisition" / "Disposal"
      instrumentType:    c[12]?.trim() || null,
      isin:              c[14]?.trim() || null,
      txDateStr:         c[15]?.trim() || null,   // "DD/MM/YYYY 00:00:00"
      volume:            c[16]?.trim() || null,   // "12345.0"
      price:             c[18]?.trim() || null,
      currency:          c[19]?.trim() || 'SEK',
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeSE() {
  console.log('🇸🇪  Finansinspektionen Sweden — Insynsregistret (CSV export)');
  const t0 = Date.now();
  const co = cutoff();
  const from = isoDate(co), to = isoDate(new Date());

  console.log(`  Fetching CSV export ${from} → ${to}…`);

  let allRaw;
  try {
    allRaw = await fetchCsv(from, to);
  } catch (err) {
    console.error(`  ❌ CSV fetch failed: ${err.message}`);
    return { saved: 0 };
  }

  console.log(`  ${allRaw.length} rows in CSV`);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen   = new Set();
  const dbRows = [];
  let corpFilings = 0, skippedOld = 0;

  for (const r of allRaw) {
    // Parse and validate transaction date
    const txDate = parseFIDate(r.txDateStr);
    if (!txDate || txDate < co) { skippedOld++; continue; }
    const txIso = isoDate(txDate);

    // Insider identity: use PDMR name [4]; if closely associated, notifier [3] → via_entity
    const insiderRaw   = r.insider   || r.notifier || null;
    const viaEntityRaw = (r.closelyAssociated === 'Yes' && r.notifier !== r.insider)
      ? r.notifier : null;

    const txType = mapType(r.nature);
    const shares = parseShares(r.volume);
    const price  = parseNum(r.price);
    const total  = (shares && price) ? Math.round(shares * price) : null;

    const fid = contentId(COUNTRY_CODE, r.company, insiderRaw, txType, txIso, shares, price);
    if (seen.has(fid)) continue;
    seen.add(fid);

    if (insiderRaw && looksLikeCorp(insiderRaw) && !viaEntityRaw) {
      console.log(`  ⚠  Corp entity insider: "${insiderRaw}" @ ${r.company} on ${txIso}`);
      corpFilings++;
    }

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           getTicker(r.company),
      _isin:            r.isin || null,
      company:          r.company || null,
      insider_name:     insiderRaw || null,
      via_entity:       viaEntityRaw || null,
      insider_role:     translateRole(r.position) || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           shares !== null ? Math.round(shares) : null,
      price_per_share:  price,
      total_value:      total,
      currency:         r.currency || 'SEK',
      filing_url:       `${BASE}?SearchFunctionType=Insyn&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}`,
      source:           SOURCE,
    });
  }

  if (skippedOld)   console.log(`  ℹ  Skipped ${skippedOld} rows older than cutoff`);
  if (corpFilings)  console.log(`  ℹ  ${corpFilings} corporate-entity insider rows (will be dropped by db filter)`);
  console.log(`  ${dbRows.length} unique rows`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  // ISIN fallback: resolve ticker via Yahoo for rows where company-name lookup failed
  let isinResolved = 0;
  for (const r of dbRows) {
    if (!r.ticker && r._isin) {
      const t = await isinToTicker(r._isin, COUNTRY_CODE);
      if (t) { r.ticker = t; isinResolved++; }
      await new Promise(res => setTimeout(res, 120));
    }
  }
  if (isinResolved) console.log(`  Resolved ${isinResolved} tickers via ISIN lookup`);

  const saveRows = dbRows.map(({ _isin, ...rest }) => rest);
  const { error } = await saveInsiderTransactions(saveRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = saveRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = saveRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${saveRows.length} saved (${buys} BUY, ${sells} SELL)`);
  console.log(`  Sample: ${saveRows.slice(0,3).map(r=>`${r.company}/${r.transaction_type}`).join(', ')}`);
  return { saved: saveRows.length };
}

scrapeSE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
