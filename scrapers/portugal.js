/**
 * PT — Insider Transactions Scraper
 *
 * Source: CMVM (Comissão do Mercado de Valores Mobiliários) Portugal
 * Portal: https://www.cmvm.pt/PInstitucional/ → SDI → Emitentes → Transações de dirigentes
 *
 * Strategy:
 *   1. Use Puppeteer to navigate CMVM's OutSystems portal to the
 *      "Transações de dirigentes" (Management Transactions) section.
 *   2. Intercept the DataActionGetReports API response, which returns a list
 *      of TRAN PDF notifications with metadata (company, date, encryptedURL).
 *   3. For each recent TRAN notification, navigate to its EncryptedURL to obtain
 *      the base64-encoded PDF via DataActionFetchDecriptInput.
 *   4. Decode the PDF and extract structured fields using pdftotext (poppler-utils).
 *   5. Save to Supabase.
 *
 * PDF fields extracted (ESMA MAR Art. 19 form in Portuguese):
 *   - ISIN (PTXXXXXXXXXX)
 *   - Company name (from 3a Nome in ESMA form)
 *   - Insider name (from 4a Código de identificação narrative)
 *   - Role (from form narrative, e.g. "membro do Conselho de Administração")
 *   - Transaction type (Aquisição → BUY, Alienação → SELL)
 *   - Price per share (EUR)
 *   - Shares (volume)
 *   - Transaction date (YYYY-MM-DD)
 *   - LEI, market
 *
 * GitHub Actions: requires poppler-utils for pdftotext.
 *   Add before this step: sudo apt-get install -y poppler-utils
 */
'use strict';

const puppeteer              = require('puppeteer');
const { execSync }           = require('child_process');
const fs                     = require('fs');
const path                   = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { isinToTicker }            = require('./lib/isinToTicker');
const { looksLikeCorp }           = require('./lib/entityUtils');

const COUNTRY_CODE   = 'PT';
const SOURCE         = 'CMVM Portugal';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
// Sequential fetching (=1) avoids CMVM session conflicts where multiple
// concurrent Puppeteer pages cause the server to return wrong cached PDFs.
const CONCURRENCY    = 1;

// CMVM portal is hard-capped at 30 most recent TRAN items (OutSystems DataActionGetReports,
// MaxRecords: 30). Pagination via StartIndex returns HTTP 403 server-side; date filters
// in the UI cannot be activated from Puppeteer (OutSystems React state management requires
// internal event propagation that dispatchEvent does not trigger). If Portuguese insider
// transaction volume exceeds ~30 filings per RETENTION_DAYS window, older items will be
// silently truncated. This check detects that condition and triggers an alert.
const CMVM_ITEM_CAP       = 30;
// Threshold: warn if oldest visible item is fewer than this many days old
const CAP_WARN_DAYS       = 14;
const CAP_ALERT_DAYS      = 7;
const ALERT_EMAIL         = process.env.NOTIFY_OWNER_EMAIL || 'jcdeboer@yahoo.com';

// CMVM SDI Emitentes page (parent of Transações de dirigentes)
const CMVM_SDI_URL = 'https://www.cmvm.pt/PInstitucional/Content?Input=2B37E09A59A0DF80BE92EC680DBABCB75C076B608267088F60A006ACD2620D69';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── PDF text extraction ───────────────────────────────────────────────────────

function pdfBase64ToText(base64) {
  const buf = Buffer.from(base64, 'base64');
  const tmpFile = path.join('/tmp', `cmvm-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmpFile, buf);
    return execSync(`pdftotext "${tmpFile}" -`, { encoding: 'utf8', timeout: 15000 });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
}

// ─── PDF field parser ──────────────────────────────────────────────────────────

/**
 * Parse CMVM TRAN PDF text (from pdftotext).
 *
 * Two filing formats are used by Portuguese companies:
 *
 * Format A — Standard ESMA form in Portuguese (e.g. Novabase):
 *   Fields like "Dados das pessoas", "Cargo/estatuto", "Data da operação".
 *   Insider name appears in 4a narrative: "Pessoas com responsabilidades de direção: {name}"
 *
 * Format B — Free-text English (e.g. NOS):
 *   "...hereby informs on the transaction of NOS shares by {name}, Manager (Dirigente)"
 *   Table with "ISIN Code", "Price and Volume: € {price} (per share) / {N} shares"
 */
function parsePdfFields(text) {
  // ── Insider name ──────────────────────────────────────────────────────────────

  let insiderName = null;

  // Format A: "Pessoas com responsabilidades de direção: Name\nSurname"
  const ptNameMatch = text.match(
    /Pessoas com responsabilidades de dire[çc][aã]o:\s*([\s\S]+?)(?=\n\n|A presente)/
  );
  if (ptNameMatch) {
    insiderName = ptNameMatch[1]
      .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  }

  // Format B: "hereby informs on the transaction of ... shares by Name, Role"
  // Name may wrap to the next line (e.g. "Manuel António Neto Portugal\nRamalho Eanes,")
  // Use non-greedy [\s\S]+? to match the FIRST "by" occurrence, not the last.
  // The old [^b]+ would stop at any 'b' char then greedily backtrack to the rightmost
  // "by", which could be "...by With purchase instruction transmitted on..." in NOS PDFs.
  if (!insiderName) {
    const enNameMatch = text.match(
      /hereby informs on the transaction of [\s\S]+?by ([^,\n]{3,80}),/i
    );
    if (enNameMatch) insiderName = enNameMatch[1].trim().replace(/\s+/g, ' ');
  }

  // Fallback: ESMA standard English form section 1a "a) Name"
  if (!insiderName) {
    const sec1aEn = text.match(/\ba\)\s*Name\s*\n[\s\n]*([A-Z][^\n]{2,120})/);
    if (sec1aEn) insiderName = sec1aEn[1].trim();
  }

  // Fallback: 1a Nome field if filled
  if (!insiderName) {
    const sec1a = text.match(/\ba\)\s*Nome\s*\n\s*([A-Z][^\n]{5,80})/);
    if (sec1a) insiderName = sec1a[1].trim();
  }

  // Post-extraction: reject names that contain transaction instruction/mechanism text.
  // NOS PDFs can write "...by With purchase instruction transmitted on YYYY-MM-DD – HHhMM,"
  // (describing the order execution method) which the Format B regex would pick up.
  if (insiderName) {
    const ARTIFACT_RE = /\binstruction\b|\btransmitted\b|\bpurchase\s+order\b/i;
    const ARTIFACT_START = /^(?:with|following|pursuant|per|order|via)\s+/i;
    if (ARTIFACT_RE.test(insiderName) || ARTIFACT_START.test(insiderName)) {
      console.log(`    ⚠  Discarding name artifact: "${insiderName.slice(0, 70)}"`);
      insiderName = null;
    }
  }

  // ── Role ─────────────────────────────────────────────────────────────────────

  let roleRaw = null;

  // Format A: "membro do Conselho de\nAdministração"
  const ptRoleMatch = text.match(
    /(?:membro d[ao]s?|na qualidade de)\s+([\s\S]+?)(?=\n\n|Notifica|Inicial)/
  );
  if (ptRoleMatch) {
    roleRaw = ptRoleMatch[1]
      .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  }

  // Format B: "Name, Manager (Dirigente)" or "Name, Director"
  if (!roleRaw) {
    const enRoleMatch = text.match(
      /by [^,\n]+,\s*([^,\n(]+(?:\([^)]+\))?)/i
    );
    if (enRoleMatch) roleRaw = enRoleMatch[1].trim();
  }

  // Fallback: 2a Cargo/estatuto
  if (!roleRaw) {
    const cargoMatch = text.match(/Cargo\/estatuto\s+([^\n]{5,80})/i);
    if (cargoMatch) roleRaw = cargoMatch[1].trim();
  }

  // ── Company ───────────────────────────────────────────────────────────────────

  let company = null;

  // Format A: section 3a Nome
  const ptCompMatch = text.match(/a\)\s*Nome\s*\n([\s\S]+?)(?:\nb\)|$)/);
  if (ptCompMatch) {
    const comp = ptCompMatch[1].split('\n').map(l => l.trim()).filter(Boolean)
      .find(l => l.length > 5 && /S\.A\.|SGPS|S\.A|Ltd|plc|\bSA\b|NV|SARL/i.test(l));
    if (comp) company = comp;
  }

  // Format B: "Issuer Company\n\n{name}" or "Issuer Company  {name}"
  if (!company) {
    const issuerMatch = text.match(/Issuer Company\s+([\s\S]+?)(?:\n\n|LEI)/);
    if (issuerMatch) {
      // Filter out dates, timestamps, and transaction instruction lines
      // e.g. "2026-03-31 – 08h00 WEST" or "With purchase instruction transmitted on 2026-03-20"
      const lines = issuerMatch[1].split('\n').map(l => l.trim()).filter(l =>
        l.length > 2 &&
        !/^\d{4}-\d{2}-\d{2}/.test(l) &&
        !/^\d{2}[hH]\d{2}/.test(l) &&
        !/\binstruction\b|\btransmitted\b/i.test(l) &&
        !/^(?:with|following|pursuant)\s+/i.test(l)
      );
      if (lines.length) company = lines.join(' ').slice(0, 150);
    }
  }

  // ── ISIN ─────────────────────────────────────────────────────────────────────

  // Flexible: match "ISIN" or "ISIN Code" followed (within ~100 chars) by the ISIN code
  let isinM = text.match(/ISIN(?:\s+Code)?\s*[\s\S]{0,80}?([A-Z]{2}[A-Z0-9]{9}[0-9])/);
  // Fallback: ESMA table format — ISIN appears before "Identification code" label
  if (!isinM) isinM = text.match(/([A-Z]{2}[A-Z0-9]{9}[0-9])[\s\n]*(?:type of instrument[\s\n]*)?Identification code/);
  // Fallback: any ISIN-shaped string in the text
  if (!isinM) isinM = text.match(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/);
  const isin = isinM ? isinM[1] : null;

  // ── LEI ──────────────────────────────────────────────────────────────────────
  const leiMatch = text.match(/\bLEI\b\s+([A-Z0-9]{20})/i);
  const lei = leiMatch ? leiMatch[1] : null;

  // ── Transaction type ──────────────────────────────────────────────────────────
  const isBuy  = /Aquisi[çc][aã]o|Acquisition of|purchased|Award of|Subscri/i.test(text);
  const isSell = /Aliena[çc][aã]o|Sale of|sold|disposal/i.test(text);
  const transactionType = isBuy ? 'BUY' : isSell ? 'SELL' : 'OTHER';

  // ── Price per share ───────────────────────────────────────────────────────────

  let pricePerShare = null;

  // Format A: "9,0000 EUR / ação"
  const ptPriceMatch = text.match(/(\d+(?:[,\.]\d+)*)\s*EUR\s*\/\s*a[çc][aã]o/i);
  if (ptPriceMatch) {
    pricePerShare = parseFloat(ptPriceMatch[1].replace(/\.(\d{3})/g, '$1').replace(',', '.'));
  }

  // Format B: "€ 5.45 (per share)"
  if (pricePerShare == null) {
    const enPriceMatch = text.match(/€\s*([\d,\.]+)\s*\(per share\)/i)
      || text.match(/(\d+(?:[,\.]\d+)*)\s*EUR\s*per\s*share/i);
    if (enPriceMatch) {
      pricePerShare = parseFloat(enPriceMatch[1].replace(',', '.'));
    }
  }

  // ── Shares (volume) ──────────────────────────────────────────────────────────

  let shares = null;

  // Format A: "7029 ações" (European format, no thousands separator)
  const ptVolMatch = text.match(/(\d[\d\s]*)\s*a[çc][õo]es\b/i);
  if (ptVolMatch) {
    shares = parseInt(ptVolMatch[1].replace(/\s/g, ''), 10);
  }

  // Format B: "/ 20,410 shares" (US/EN thousands separator with comma)
  if (!shares || isNaN(shares)) {
    const enVolMatch = text.match(/\/([\s,\d]+)\s*shares/i)
      || text.match(/([\d,]+)\s*shares/i);
    if (enVolMatch) {
      shares = parseInt(enVolMatch[1].replace(/[,\s]/g, ''), 10);
    }
  }

  // Format C: ESMA standard table "c) Price(s) and volume(s) ... €N.NNNN\n\nVOLUME d)"
  // Extract entire c)...d) block and parse price (€N.N) and volume separately
  if (pricePerShare == null || !shares || isNaN(shares)) {
    const esmaBlock = text.match(/c\)\s*Price\(s\)\s*and\s*volume\(s\)([\s\S]+?)d\)\s/i)?.[1] || '';
    if (esmaBlock) {
      if (pricePerShare == null) {
        // Try with € prefix first, then bare decimal number (e.g. "9.8700\n\n4 700")
        const eurM = esmaBlock.match(/€\s*([\d,\.]+)/)
          || esmaBlock.match(/\b(\d+[.,]\d{2,4})\s*\n+\s*[\d,]{3,}/);
        if (eurM) pricePerShare = parseFloat(eurM[1].replace(',', '.'));
      }
      if (!shares || isNaN(shares)) {
        // Volume appears after the price (€...) in the block — skip the price digits
        const volM = esmaBlock.match(/€[\d.,]+\s*\n+\s*([\d,\s]+)/)
          || esmaBlock.match(/\b\d+[.,]\d+\s*\n+\s*([\d,\s]{3,})/)
          || esmaBlock.match(/Volume\(s\)\s*\n[\s\S]*?\n\s*([\d]{1,3}(?:,[\d]{3})+)\s*\n/i);
        if (volM) shares = parseInt(volM[1].replace(/[,\s]/g, ''), 10);
      }
    }
  }

  // Format D: ESMA aggregated table — "N.NNNN EUR   N,NNN" on same/adjacent lines
  if (pricePerShare == null) {
    const aggM = text.match(/(\d+[.,]\d{2,4})\s+EUR\s+(\d[\d,\s]+)/i);
    if (aggM) {
      const p = parseFloat(aggM[1].replace(',', '.'));
      if (p > 0) pricePerShare = p;
      if (!shares || isNaN(shares)) {
        const s = parseInt(aggM[2].replace(/[,\s]/g, ''), 10);
        if (s > 0) shares = s;
      }
    }
  }

  if (isNaN(shares)) shares = null;

  // ── Transaction date ──────────────────────────────────────────────────────────

  // Format A: "Data da operação 2026-04-07"
  const ptDateMatch = text.match(/Data da opera[çc][aã]o\s+(\d{4}-\d{2}-\d{2})/i);
  // Format B/C: "Date of the transaction\n\n2026-04-13" or "Date  2026-03-31"
  const enDateMatch = text.match(/Date\s+of\s+the\s+transaction[\s\S]{0,10}?(\d{4}-\d{2}-\d{2})/i)
    || text.match(/\bDate\b\s+(\d{4}-\d{2}-\d{2})/i);
  const transactionDate = (ptDateMatch || enDateMatch || [])[1] || null;

  // ── Market ────────────────────────────────────────────────────────────────────
  const marketMatch = text.match(/(?:Local da opera[çc][aã]o|Place of the transaction|Location)\s+([^\n\d][^\n]{2,50})/i);
  const market = marketMatch ? marketMatch[1].trim() : null;

  return { insiderName, roleRaw, company, isin, lei, transactionType, pricePerShare, shares, transactionDate, market };
}

// ─── Role translation ─────────────────────────────────────────────────────────

const PT_ROLE_EXTRA = [
  [/conselho de administra[çc][aã]o/i, 'Board Member'],
  [/[oó]rg[aã]o de administra[çc][aã]o/i, 'Board Member'],
  [/comiss[aã]o executiva/i, 'Senior Executive'],
  [/presidente do conselho/i, 'Chairman'],
  [/conselho de supervis[aã]o/i, 'Board Member'],
  [/membro do conselho/i, 'Board Member'],
];

function translatePtRole(raw) {
  if (!raw) return null;
  for (const [pattern, english] of PT_ROLE_EXTRA) {
    if (pattern.test(raw)) return english;
  }
  return translateRole(raw);
}

// ─── Cap alert ────────────────────────────────────────────────────────────────

async function sendCapAlert(daysOld, oldestDate) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠  RESEND_API_KEY not set — cannot send cap alert email');
    return;
  }
  const subject = `InsidersAlpha: Portugal CMVM cap overflow detected`;
  const html = `
<p><strong>CMVM 30-item cap overflow detected</strong></p>
<p>The oldest visible TRAN filing is only <strong>${daysOld} days old</strong>
(${oldestDate}), meaning transactions from earlier dates are being silently
truncated by the portal's 30-item limit.</p>
<p><strong>Action required:</strong> Check
<a href="https://www.cmvm.pt/PInstitucional/Content?Input=2B37E09A59A0DF80BE92EC680DBABCB75C076B608267088F60A006ACD2620D69">CMVM SDI portal</a>
manually to identify any missed filings.</p>
<p style="color:#9CA3AF;font-size:12px">InsidersAlpha · Portugal scraper</p>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'InsidersAlpha Alerts <alerts@insidersalpha.com>',
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    });
    if (res.ok) console.log(`  📧 Cap alert email sent to ${ALERT_EMAIL}`);
    else console.warn(`  ⚠  Failed to send cap alert email: ${res.status}`);
  } catch(e) {
    console.warn(`  ⚠  Cap alert email error: ${e.message}`);
  }
}

// ─── Browser launch helper ────────────────────────────────────────────────────

function launchBrowser(chromiumPath) {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--js-flags=--max-old-space-size=512',
    ],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });
}

// ─── Puppeteer navigation ─────────────────────────────────────────────────────

async function fetchTranList(browser) {
  const page = await browser.newPage();
  const items = [];

  await page.setRequestInterception(true);
  page.on('request', req => req.continue());
  page.on('response', async res => {
    if (res.url().includes('DataActionGetReports')) {
      try {
        const json = await res.json();
        const list = json?.data?.ReportsList?.List || [];
        if (list.length > 0 && items.length === 0) {
          items.push(...list);
        }
      } catch(e) {}
    }
  });

  // Retry initial navigation — CMVM portal is slow and occasionally times out
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CMVM_SDI_URL, { waitUntil: 'networkidle2', timeout: 120000 });
      break;
    } catch(e) {
      if (attempt >= 3) throw e;
      console.log(`  ⚠  CMVM portal navigation timeout (attempt ${attempt}/3), retrying in 10s…`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click "Participações e operações sobre valores mobiliários"
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span, a, li'));
    const t = spans.find(el => el.textContent.trim().startsWith('Participações e operações'));
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  // Click "Transações de dirigentes"
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span, a, li'));
    const t = spans.find(el => el.textContent.trim() === 'Transações de dirigentes');
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  await page.close();
  return items;
}

async function fetchPdfBase64(browser, encryptedURL) {
  const page = await browser.newPage();
  let base64 = null;

  await page.setRequestInterception(true);
  page.on('request', req => req.continue());
  page.on('response', async res => {
    if (res.url().includes('DataActionFetchDecriptInput')) {
      try {
        const json = await res.json();
        const b64 = json?.data?.FileBase64;
        if (b64 && b64.length > 1000) base64 = b64;
      } catch(e) {}
    }
  });

  // Retry up to 3 times for navigation timeouts.
  // Connection/target-closed errors are rethrown immediately — the outer loop
  // will restart the browser rather than retrying with a dead session.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(encryptedURL, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 4000));
      break;
    } catch(e) {
      const isConnectionErr = /connection closed|target closed|session closed|context.*destroyed/i.test(e.message);
      if (isConnectionErr) {
        await page.close().catch(() => {});
        throw e;  // propagate — caller will restart browser
      }
      if (attempt < 3) {
        console.log(`  ⚠  PDF navigation timeout (attempt ${attempt}/3), retrying…`);
        await new Promise(r => setTimeout(r, 10000));
      }
      // timeout on final attempt is OK — may have already captured response
    }
  }
  await page.close().catch(() => {});

  return base64;
}

// ─── Concurrency helper ────────────────────────────────────────────────────────

async function mapConcurrent(items, fn, concurrency) {
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

// ─── Main ──────────────────────────────────────────────────────────────────────

async function scrapePT() {
  console.log('🇵🇹  CMVM Portugal — MAR Article 19 management transactions');
  const t0 = Date.now();

  // Verify pdftotext is available
  try {
    execSync('pdftotext -v 2>&1', { encoding: 'utf8' });
  } catch(e) {
    // pdftotext writes version info to stderr, so non-zero exit is expected
    if (!/pdftotext/i.test(String(e.stderr || e.stdout || ''))) {
      console.log('  ⚠  pdftotext not found. Install poppler-utils:');
      console.log('       sudo apt-get install -y poppler-utils');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffIso = isoDate(cutoffDate);
  console.log(`  Fetching transactions since ${cutoffIso}…`);

  // Resolve Chromium path: env var → common Linux paths → puppeteer bundled cache
  const { execSync: _exec } = require('child_process');
  function findChromium() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    for (const p of candidates) {
      try { _exec(`test -x ${p}`, { stdio: 'ignore' }); return p; } catch {}
    }
    // Explicitly resolve puppeteer's own downloaded browser (~/.cache/puppeteer/).
    // Returning undefined would let puppeteer auto-detect, but on some server
    // environments that silently fails; explicit path is more reliable.
    try { return puppeteer.executablePath(); } catch {}
    return undefined;
  }
  const chromiumPath = findChromium();
  console.log(`  Using Chromium: ${chromiumPath || '(puppeteer default)'}`);

  let browser = await launchBrowser(chromiumPath);

  try {
    // Step 1: Navigate and capture TRAN list
    console.log('  Navigating CMVM SDI portal…');
    const allItems = await fetchTranList(browser);

    if (!allItems.length) {
      console.log('  ⚠  DataActionGetReports returned no items — portal may be unavailable.');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }

    console.log(`  Found ${allItems.length} TRAN items in portal`);

    // ── Cap overflow check ────────────────────────────────────────────────────
    // The CMVM portal hard-limits responses to CMVM_ITEM_CAP (30) most recent items.
    // If we're AT the cap, check how old the oldest item is. If it's very recent,
    // higher-volume periods may be truncating older filings we need.
    if (allItems.length >= CMVM_ITEM_CAP) {
      const tranOnly = allItems.filter(i => i.PDF_FACT?.startsWith('TRAN') && i.DATA_FACT);
      if (tranOnly.length > 0) {
        const oldest = tranOnly.reduce((a, b) => a.DATA_FACT < b.DATA_FACT ? a : b);
        const daysOld = Math.floor((Date.now() - new Date(oldest.DATA_FACT).getTime()) / 86_400_000);
        console.log(`  Oldest TRAN item: ${oldest.DATA_FACT} (${daysOld} days ago, PDF: ${oldest.PDF_FACT})`);

        if (daysOld < CAP_ALERT_DAYS) {
          console.warn(`  🚨 CAP OVERFLOW: oldest item only ${daysOld}d old — filings beyond day ${daysOld} are hidden`);
          await sendCapAlert(daysOld, oldest.DATA_FACT);
        } else if (daysOld < CAP_WARN_DAYS) {
          console.warn(`  ⚠  CAP WARNING: oldest item ${daysOld}d old — approaching 30-item limit (alert at < ${CAP_ALERT_DAYS}d)`);
        } else {
          console.log(`  ✓  Cap OK: ${daysOld} days of coverage visible`);
        }
      }
    }

    // Step 2: Filter to TRAN items within date range.
    // CMVM publishes each notification in two languages (EN + PT) with consecutive PDF numbers.
    // Strategy: prefer IsEN=true items; include PT-only items where no EN equivalent exists.
    // Group by normalized company name + publication date to detect EN/PT pairs.

    const enItems = [];
    const ptItems = [];

    for (const item of allItems) {
      if (!item.PDF_FACT || !item.PDF_FACT.startsWith('TRAN')) continue;
      if (!item.DATA_FACT || item.DATA_FACT < cutoffIso) continue;
      if (item.IsEN) enItems.push(item);
      else ptItems.push(item);
    }

    // Build set of EN-covered (company+date) keys
    const enCovered = new Set(
      enItems.map(i => normKey(i))
    );

    function normKey(item) {
      // Strip language-dependent suffix to get company name
      const co = (item.DSC_FACT || '')
        .replace(/\s*informs?[^,]*$/i, '')
        .replace(/\s*informa.*$/i, '')
        .trim().toLowerCase();
      return `${item.DATA_FACT}-${co}`;
    }

    // PT-only items: those where no EN equivalent exists
    const ptOnly = ptItems.filter(i => !enCovered.has(normKey(i)));

    const toProcess = [...enItems, ...ptOnly];

    console.log(`  ${toProcess.length} unique TRAN notifications within last ${RETENTION_DAYS} days`);

    if (!toProcess.length) {
      console.log('  Nothing in retention window.');
      return { saved: 0 };
    }

    // Step 3: Download and parse each PDF — sequential with browser-restart on crash.
    // Each PDF gets up to 2 attempts; on a browser connection crash the browser is
    // relaunched and the PDF is retried once before being skipped.
    console.log(`  Downloading and parsing PDFs (sequential, restart-on-crash)…`);

    const parsed = [];
    for (let idx = 0; idx < toProcess.length; idx++) {
      const item = toProcess[idx];
      const pdfNum = item.PDF_FACT.replace(/\D/g, '');
      console.log(`    [${idx+1}/${toProcess.length}] ${item.PDF_FACT} — ${(item.DSC_FACT || '').slice(0, 60)}`);

      let result = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const base64 = await fetchPdfBase64(browser, item.EncryptedURL);
          if (!base64) {
            console.log(`      ⚠  Could not get PDF base64`);
            break;
          }
          let text;
          try {
            text = pdfBase64ToText(base64);
          } catch(e) {
            console.log(`      ⚠  pdftotext failed: ${e.message}`);
            break;
          }
          const fields = parsePdfFields(text);
          console.log(`      → ${fields.insiderName || '(no name)'} | ${fields.isin || '(no ISIN)'} | ${fields.transactionType} | ${fields.shares}@${fields.pricePerShare} | ${fields.transactionDate}`);
          result = { item, fields, pdfNum };
          break;
        } catch(err) {
          const isCrash = /connection closed|target closed|session closed|context.*destroyed/i.test(err.message);
          if (isCrash) {
            console.warn(`      ⚠  Browser crashed (${err.message.slice(0, 60)}), restarting…`);
            await browser.close().catch(() => {});
            browser = await launchBrowser(chromiumPath);
            if (attempt >= 2) {
              console.warn(`      ⚠  Skipping ${item.PDF_FACT} after 2 crash attempts`);
            }
            // loop continues to retry with fresh browser
          } else {
            console.warn(`      ⚠  Skipping ${item.PDF_FACT}: ${err.message.slice(0, 80)}`);
            break;
          }
        }
      }
      parsed.push(result);
    }

    // Step 4: Build DB rows
    // filing_id = PT-{pdfNum} is unique per PDF, so Supabase upsert handles
    // idempotency. No additional in-scraper dedup needed since we already
    // filtered to one version (EN preferred) per notification.
    const dbRows = [];

    for (const result of parsed) {
      if (!result) continue;
      const { item, fields, pdfNum } = result;

      // Derive company from PDF (3a Nome) or from notification DSC_FACT title
      const company = fields.company
        || (item.DSC_FACT || '').replace(/\s*informs?.*$/i, '').replace(/\s*informa.*$/i, '').trim()
        || null;

      const role = translatePtRole(fields.roleRaw);
      const totalValue = (fields.pricePerShare != null && fields.shares != null)
        ? Math.round(fields.pricePerShare * fields.shares)
        : null;

      dbRows.push({
        filing_id:        `PT-${pdfNum}`,
        country_code:     COUNTRY_CODE,
        ticker:           fields.isin ? (await isinToTicker(fields.isin, COUNTRY_CODE) || '') : '',
        company,
        insider_name:     (fields.insiderName && looksLikeCorp(fields.insiderName)) ? null : (fields.insiderName || null),
        via_entity:       (fields.insiderName && looksLikeCorp(fields.insiderName)) ? fields.insiderName : null,
        insider_role:     role || null,
        transaction_type: fields.transactionType,
        transaction_date: fields.transactionDate || item.DATA_FACT,
        shares:           fields.shares,
        price_per_share:  fields.pricePerShare,
        total_value:      totalValue,
        currency:         CURRENCY,
        filing_url:       item.EncryptedURL,
        source:           SOURCE,
      });
    }

    if (!dbRows.length) {
      console.log('  Nothing to save after parsing.');
      return { saved: 0 };
    }

    const { error } = await saveInsiderTransactions(dbRows);
    if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

    const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
    const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
    console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
    return { saved: dbRows.length };

  } finally {
    await browser.close();
  }
}

scrapePT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
