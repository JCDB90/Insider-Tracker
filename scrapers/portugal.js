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

const COUNTRY_CODE   = 'PT';
const SOURCE         = 'CMVM Portugal';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';
// Sequential fetching (=1) avoids CMVM session conflicts where multiple
// concurrent Puppeteer pages cause the server to return wrong cached PDFs.
const CONCURRENCY    = 1;

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
  if (!insiderName) {
    const enNameMatch = text.match(
      /hereby informs on the transaction of [^b]+by ([^,\n]+),/i
    );
    if (enNameMatch) insiderName = enNameMatch[1].trim();
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
      // Filter out lines that look like dates or timestamps (e.g. "2026-03-31 – 08h00 WEST")
      const lines = issuerMatch[1].split('\n').map(l => l.trim()).filter(l =>
        l.length > 2 && !/^\d{4}-\d{2}-\d{2}/.test(l) && !/^\d{2}[hH]\d{2}/.test(l)
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
        const eurM = esmaBlock.match(/€\s*([\d,\.]+)/);
        if (eurM) pricePerShare = parseFloat(eurM[1].replace(',', '.'));
      }
      if (!shares || isNaN(shares)) {
        // Volume appears after the price (€...) in the block — skip the price digits
        const volM = esmaBlock.match(/€[\d.,]+\s*\n+\s*([\d,]+)/)
          || esmaBlock.match(/Volume\(s\)\s*\n[\s\S]*?\n\s*([\d]{1,3}(?:,[\d]{3})+)\s*\n/i);
        if (volM) shares = parseInt(volM[1].replace(/,/g, ''), 10);
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

  await page.goto(CMVM_SDI_URL, { waitUntil: 'networkidle2', timeout: 60000 });
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

  try {
    await page.goto(encryptedURL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));
  } catch(e) {
    // timeout is OK — we may have already captured the response
  } finally {
    await page.close();
  }

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

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

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

    // Step 3: Download and parse each PDF
    console.log(`  Downloading and parsing PDFs (${CONCURRENCY} concurrent)…`);

    const parsed = await mapConcurrent(toProcess, async (item, idx) => {
      const pdfNum = item.PDF_FACT.replace(/\D/g, '');
      console.log(`    [${idx+1}/${toProcess.length}] ${item.PDF_FACT} — ${(item.DSC_FACT || '').slice(0, 60)}`);

      const base64 = await fetchPdfBase64(browser, item.EncryptedURL);
      if (!base64) {
        console.log(`      ⚠  Could not get PDF base64`);
        return null;
      }

      let text;
      try {
        text = pdfBase64ToText(base64);
      } catch(e) {
        console.log(`      ⚠  pdftotext failed: ${e.message}`);
        return null;
      }

      const fields = parsePdfFields(text);
      console.log(`      → ${fields.insiderName || '(no name)'} | ${fields.isin || '(no ISIN)'} | ${fields.transactionType} | ${fields.shares}@${fields.pricePerShare} | ${fields.transactionDate}`);
      return { item, fields, pdfNum };
    }, CONCURRENCY);

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
        ticker:           fields.isin || '',
        company,
        insider_name:     fields.insiderName || null,
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
