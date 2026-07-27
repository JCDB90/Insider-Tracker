/**
 * SG — Insider Transactions Scraper
 *
 * Source: SGX (Singapore Exchange) company announcements — category ANNC14
 * "Disclosure of Interest/ Changes in Interest", covering both director/CEO
 * notifications (SFA s.137) and substantial shareholder notifications
 * (SFA s.137/Part XII). Legal basis: Securities and Futures Act.
 *
 * ── History ──────────────────────────────────────────────────────────────
 * Singapore was built once before (May 2026) and then deliberately removed
 * (commit 55cd679: "SGX PDFs are AES-encrypted (copy:no) by MAS — shares/
 * price cannot be extracted"). That conclusion was correct about the PDFs'
 * permission flags but wrong about extractability: `qpdf --show-encryption`
 * confirms AESv2 encryption with an EMPTY user password and "extract: not
 * allowed" — a soft DRM flag that only cooperative viewers honor. poppler's
 * pdftotext (what was tried previously) respects that flag and refuses to
 * extract. qpdf does not — it decrypts with the (blank) user password and
 * dumps the raw, uncompressed object stream regardless of the permission
 * bits. That stream turns out to be a fully populated Adobe LiveCycle XFA
 * `<xfa:datasets>` XML packet: real director/shareholder names, share
 * counts, considerations, and dates, in machine-readable form — richer
 * than the HTML-metadata-only fallback the old version shipped with
 * (which saved BUY/SELL rows with null shares/price).
 *
 * ── Architecture (two-tier, like Austria/Portugal but split differently) ──
 *   1. LISTING: `https://api.sgx.com/announcements/v1.1/` is real but sits
 *      behind Akamai bot-management — a plain curl/fetch gets HTTP 403
 *      (edge block) even with the exact `authorizationtoken` header and
 *      `referer` a real browser sends; only a genuine Puppeteer/Chromium
 *      session passes. So Puppeteer is used ONLY to load the announcements
 *      page once, capture the (confirmed-static across sessions)
 *      `authorizationtoken` header, and drive the listing fetches via
 *      in-page `fetch()` (same-origin, so Akamai sees a real browser call).
 *   2. DOCUMENTS: the PDFs themselves live on `links.sgx.com`, a different,
 *      Akamai-free CDN — plain `fetch()` with no browser needed.
 *
 *   `category=ANNC14` and `periodstart=/periodend=` query params are both
 *   confirmed no-ops (same pattern as Austria's `meldetypCode` and Poland's
 *   RSS filters) — the server always returns its full backlog, paginated
 *   with `pagestart` as a page INDEX (not an item offset) at whatever
 *   `pagesize` is requested. Filtering by category and date is done
 *   client-side, same as every other scraper here. Pages are *mostly*
 *   newest-first by `submission_date_time` but not strictly monotonic (a
 *   handful of stale/republished items surface out of order), so the
 *   pagination cutoff check uses each page's MAX date, not its min — using
 *   min caused a premature stop in testing.
 *
 * ── Document form ──────────────────────────────────────────────────────────
 * A single XFA template ("SFA289") is reused for every filing, with repeating
 * `<Transaction>` blocks (director and substantial-shareholder filings use
 * the same shape); an initial holding disclosure (e.g. a newly appointed
 * director's existing stake, no real change) simply has none. Direction and
 * share count are NOT reliably read from prose: many filers just write
 * "34,500 Ordinary Shares" with no verb at all and rely on a checkbox code
 * (`circumstances/selection`) whose meaning depends on which of the form's
 * "Acquisition of:" / "Disposal of:" checkbox groups it came from — not
 * recoverable from the data packet alone. Instead each block's own T1Ord
 * before/after holding totals are used: an increase is a BUY, a decrease a
 * SELL, and |after − before| is the authoritative share count, falling back
 * to a free-text parse of `numShares` only when before/after aren't present
 * (e.g. non-equity instruments like a digital-token subscription). Price
 * comes from `amtConsideration`, a free-text field (e.g. "S$0.3527 per
 * Unit" vs "SGD 8,850,000" total) — "per unit/share" phrasing distinguishes
 * a per-share price from a total consideration (same ambiguity Austria's
 * header documents for its "Aggregated price" field). When numShares' and
 * amtConsideration's own verbs flatly disagree (confirmed live: a Bank of
 * America/Merrill Lynch nominee-chain filing pairing "Disposal of 268,300
 * shares" with "$3,601.17 paid to acquire shares" — two unrelated sub-events
 * under one tag pair), the price is dropped rather than trusted.
 *
 * Substantial-shareholder chains (e.g. a listed sub owned by a holdco owned
 * by an individual) list multiple `nameSubstantialShareholder` entries for
 * ONE transaction — the first non-corporate name is used as insider_name,
 * the first corporate name as via_entity (same convention as Austria's
 * closely-associated-entity handling).
 */
'use strict';

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { looksLikeCorp } = require('./lib/entityUtils');

const COUNTRY_CODE = 'SG';
const SOURCE = 'SGX Company Announcements';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY = 'SGD';
const CATEGORY = 'ANNC14';
const API_BASE = 'https://api.sgx.com/announcements/v1.1';
const ANNOUNCEMENTS_PAGE = 'https://www.sgx.com/securities/company-announcements';
const PAGE_SIZE = 20;
const MAX_PAGES = 400; // safety cap (~8,000 announcements of ANY category)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isoDate(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function cutoffYyyymmdd() {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return parseInt(isoDate(d));
}

// ─── Chromium discovery (same pattern as scrapers/portugal.js) ───────────────

function existingPath(p) {
  try { return p && fs.existsSync(p) ? p : null; } catch { return null; }
}
function findChromium() {
  const envPath = existingPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (envPath) return envPath;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) { const hit = existingPath(p); if (hit) return hit; }
  try { const bundled = existingPath(puppeteer.executablePath()); if (bundled) return bundled; } catch {}
  return null;
}

// ─── Listing (Puppeteer: token capture + in-page fetch pagination) ───────────

async function fetchListings(cutoff) {
  let chromiumPath = findChromium();
  if (!chromiumPath) {
    console.log('  ⚠  No Chromium found — attempting on-demand install…');
    try {
      execSync('npx --yes puppeteer browsers install chrome', { stdio: 'inherit', timeout: 5 * 60 * 1000 });
      chromiumPath = existingPath(puppeteer.executablePath());
    } catch (e) { console.log(`  ⚠  Install failed: ${e.message}`); }
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);

    let token = null;
    page.on('request', (req) => {
      const h = req.headers();
      if (h.authorizationtoken && !token) token = h.authorizationtoken;
    });

    await page.goto(ANNOUNCEMENTS_PAGE, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 6000));

    if (!token) { console.log('  ⚠  Could not capture authorizationtoken — aborting'); return []; }

    // periodstart/periodend don't actually filter which results come back (see
    // header note — pagination + client-side date filtering does the real work),
    // but the API DOES validate the params: it 400s with SGX_4007 if the span
    // exceeds ~20 years. Use a generous-but-safe 2-year lookback for periodstart
    // rather than a far-past sentinel, which tripped that validation in testing.
    const periodStartDate = new Date();
    periodStartDate.setFullYear(periodStartDate.getFullYear() - 2);
    const periodStartStr = isoDate(periodStartDate);
    const periodEndStr = isoDate(new Date());

    const collected = [];
    for (let pagestart = 0; pagestart < MAX_PAGES; pagestart++) {
      const result = await page.evaluate(async (t, ps, size, pstart, pend) => {
        const url = `https://api.sgx.com/announcements/v1.1/?periodstart=${pstart}_000000&periodend=${pend}_235959&pagestart=${ps}&pagesize=${size}`;
        try {
          const res = await fetch(url, { headers: { accept: 'application/json', authorizationtoken: t } });
          return { status: res.status, text: await res.text() };
        } catch (e) { return { status: 0, text: '', err: e.message }; }
      }, token, pagestart, PAGE_SIZE, periodStartStr, periodEndStr);

      if (result.status !== 200) { console.log(`  ⚠  page ${pagestart}: HTTP ${result.status}`); break; }
      let d;
      try { d = JSON.parse(result.text); } catch { break; }
      if (!d.data || !d.data.length) break;

      collected.push(...d.data);
      const maxDate = Math.max(...d.data.map((i) => parseInt(i.submission_date, 10) || 0));
      if (maxDate < cutoff) break; // page is entirely older than our window — safe to stop (see header note)
      await new Promise((r) => setTimeout(r, 200)); // be polite
    }

    return collected.filter((i) => i.sub === CATEGORY && parseInt(i.submission_date, 10) >= cutoff);
  } finally {
    await browser.close();
  }
}

// ─── Document fetch + XFA decrypt/extract (plain HTTP — no browser needed) ──

async function fetchDetailHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  return res.text();
}

function findFirstPdfPath(html) {
  const m = html.match(/href="([^"]*\.pdf[^"]*)"/i);
  return m ? m[1] : null;
}

async function downloadPdf(pdfUrl, refererUrl) {
  const res = await fetch(pdfUrl, { headers: { 'User-Agent': UA, Referer: refererUrl } });
  if (!res.ok) return null;
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Decrypt (empty-password AES) and pull the XFA `datasets` packet as flat text.
function extractXfaDataset(buf) {
  const tmpIn = path.join('/tmp', `sgx-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const tmpOut = `${tmpIn}.qdf.pdf`;
  try {
    fs.writeFileSync(tmpIn, buf);
    try {
      execSync(`qpdf --qdf --object-streams=disable --stream-data=uncompress "${tmpIn}" "${tmpOut}"`, { timeout: 20000, stdio: 'pipe' });
    } catch (e) {
      // qpdf exits non-zero on recoverable warnings (bad xref entries etc.) but
      // still writes a usable file — only bail if it genuinely produced nothing.
      if (!fs.existsSync(tmpOut)) return null;
    }
    const data = fs.readFileSync(tmpOut);
    const m = data.toString('latin1').match(/\(datasets\)\s*\n\s*(\d+)\s+0\s+R/);
    if (!m) return null;
    const objNum = m[1];
    const streamRe = new RegExp(`\\n${objNum} 0 obj\\n[\\s\\S]*?endstream`);
    const m2 = data.toString('latin1').match(streamRe);
    if (!m2) return null;
    return m2[0].replace(/\r?\n/g, ''); // flatten PDF-stream line-wrapping (see header)
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── XML tag extraction ───────────────────────────────────────────────────────

function getTags(name, text) {
  const re = new RegExp(`<${name}>([^<]*)</${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const v = m[1].replace(/&#xD;/g, ' ').replace(/\s+/g, ' ').trim();
    if (v) out.push(v);
  }
  return out;
}

// ─── Value parsing ────────────────────────────────────────────────────────────

function extractShareCount(text) {
  if (!text) return null;
  const m = text.match(/([\d]{1,3}(?:,\d{3})+|\d+)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractConsideration(text) {
  if (!text) return { amount: null, perShare: false };
  const m = text.match(/([\d]{1,3}(?:,\d{3})*(?:\.\d+)?|\d+\.\d+)/);
  if (!m) return { amount: null, perShare: false };
  const amount = parseFloat(m[1].replace(/,/g, ''));
  const perShare = /per\s*(unit|share)/i.test(text);
  return { amount: Number.isFinite(amount) ? amount : null, perShare };
}

function classifyTxType(text) {
  if (!text) return 'UNKNOWN';
  const t = text.toLowerCase();
  if (/dispos|redeem|\bsale\b|sold|\bsell\b|transfer(red)?\s+out/.test(t)) return 'SELL';
  if (/acqui|subscri|purchas|receipt|award|grant|\bvest|allot|issued?\s+to/.test(t)) return 'BUY';
  return 'UNKNOWN';
}

// Some filings (confirmed live: a Bank of America Corp / Merrill Lynch nominee-
// chain substantial-shareholder notice for AEM Holdings) pair a "Disposal of
// 268,300 shares" numShares with an unrelated "$3,601.17 paid to acquire
// shares" amtConsideration — two different sub-events bundled under one tag
// pair rather than one coherent transaction. When the two fields' own verbs
// flatly disagree, the pairing isn't trustworthy enough to price — keep the
// direction/shares (from numShares, the more reliable of the two) but drop
// the price so db.js's require-a-positive-price filter drops the row rather
// than publishing a number that doesn't belong to this transaction.
function considerationMatchesDirection(shareText, considText, txType) {
  const considType = classifyTxType(considText);
  return considType === 'UNKNOWN' || considType === txType;
}

// ─── Filing parser ─────────────────────────────────────────────────────────────

// Split the flattened XML into one chunk per real <Transaction> instance.
// The XFA template repeats an EMPTY placeholder for every unused slot in its
// (maxOccur=-1) schema description — those carry a `dd:maxOccur="-1"`
// attribute and are excluded here; only populated data instances match the
// bare `<Transaction>` tag with no attributes.
function splitTransactionBlocks(xml) {
  const parts = xml.split(/(?=<Transaction>)/);
  return parts.filter((p) => p.startsWith('<Transaction>'));
}

// Many filings (confirmed live: Stamford Land — "34,500 Ordinary Shares" with
// no verb at all) rely entirely on a checkbox code under circumstances/
// selection to describe HOW the change happened ("via market transaction",
// "via placement", etc.) rather than prose stating direction — and that code
// is ambiguous without knowing which of the form's "Acquisition of:" /
// "Disposal of:" checkbox groups it came from, which isn't recoverable from
// the data packet alone. The reliable, template-independent signal instead
// is each block's own T1Ord before/after holding totals: an increase is a
// BUY, a decrease is a SELL, and |after − before| is the authoritative share
// count (falling back to the free-text numShares parse when before/after
// aren't present, e.g. non-share instruments like the digital-token filings).
function extractBeforeAfterShares(block) {
  const tots = getTags('tot', block).filter((v) => !v.includes('.')).map((v) => parseInt(v, 10));
  if (tots.length < 2) return null;
  const [before, after] = tots;
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  return { delta: after - before, shares: Math.abs(after - before), txType: after > before ? 'BUY' : 'SELL' };
}

function parseFiling(xml) {
  const directors = getTags('nameDirector', xml);
  const shareholders = getTags('nameSubstantialShareholder', xml);
  const candidates = [...directors, ...shareholders];

  let insiderName = null;
  let viaEntity = null;
  for (const c of candidates) {
    if (!looksLikeCorp(c)) { insiderName = c; break; }
  }
  if (!insiderName) {
    for (const c of candidates) { if (looksLikeCorp(c)) { viaEntity = c; break; } }
  }
  const role = directors.length ? 'Director' : (shareholders.length ? 'Substantial Shareholder' : null);
  const dateNotif = getTags('dateNotification', xml);

  const transactions = [];
  for (const block of splitTransactionBlocks(xml)) {
    const shareText = (getTags('numShares', block) || [])[0] || '';
    const considText = (getTags('amtConsideration', block) || [])[0] || '';
    const dateAcq = (getTags('dateAquisition', block) || [])[0];

    const beforeAfter = extractBeforeAfterShares(block);
    const textShares = extractShareCount(shareText);
    const textType = classifyTxType(shareText);

    const shares = (beforeAfter && beforeAfter.shares) || textShares;
    const txType = (beforeAfter && beforeAfter.txType) || textType;
    if (!shares || txType === 'UNKNOWN') continue;

    const { amount, perShare } = extractConsideration(considText);
    let pricePerShare = null, totalValue = null;
    if (amount && considerationMatchesDirection(shareText, considText, textType)) {
      if (perShare) { pricePerShare = amount; totalValue = Math.round(amount * shares); }
      else { totalValue = Math.round(amount); pricePerShare = parseFloat((amount / shares).toFixed(6)); }
    }

    const txDate = parseFilingDate(dateAcq || dateNotif[0] || null);

    transactions.push({ shares, pricePerShare, totalValue, txDate, txType });
  }

  return { insiderName, viaEntity, role, transactions };
}

// Handles both "2026-07-13" (ISO) and "27-Jul-2026" (DD-Mon-YYYY) formats seen live.
function parseFilingDate(raw) {
  if (!raw) return null;
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = raw.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dmy) {
    const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    const mm = months[dmy[2].toLowerCase()];
    if (mm) return `${dmy[3]}-${mm}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeSG() {
  console.log('🇸🇬  SGX — Company Announcements (ANNC14)');
  const t0 = Date.now();
  const cutoff = cutoffYyyymmdd();
  console.log(`  Fetching filings since ${cutoff}…`);

  const listings = await fetchListings(cutoff);
  console.log(`  Found ${listings.length} ANNC14 filings in window`);
  if (!listings.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const dbRows = [];
  const seen = new Set();

  for (const item of listings) {
    const fid = `SG-${item.id}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const issuer = (item.issuers && item.issuers[0]) || {};
    const company = issuer.security_name || issuer.issuer_name || item.issuer_name || null;
    // Bare SGX code, no Yahoo suffix — CompanyPage.jsx appends .SI itself
    // (COUNTRY_YAHOO_SUFFIX['SG']), matching every other market's convention.
    const ticker = issuer.stock_code || null;

    const html = await fetchDetailHtml(item.url);
    if (!html) { console.log(`  ⚠  ${item.id} (${company}) — detail page fetch failed`); continue; }
    const pdfPath = findFirstPdfPath(html);
    if (!pdfPath) { console.log(`  ⚠  ${item.id} (${company}) — no PDF attachment found`); continue; }
    const pdfUrl = `https://links.sgx.com${pdfPath}`;

    const buf = await downloadPdf(pdfUrl, item.url);
    if (!buf) { console.log(`  ⚠  ${item.id} (${company}) — PDF download failed`); continue; }

    const xml = extractXfaDataset(buf);
    if (!xml) { console.log(`  ⚠  ${item.id} (${company}) — XFA extraction failed`); continue; }

    const f = parseFiling(xml);
    if (!f.transactions.length) {
      // Initial/holding-only disclosure with no reported change — not a transaction.
      continue;
    }
    if (!f.insiderName && !f.viaEntity) {
      console.log(`  ⚠  ${item.id} (${company}) — no insider identity found; rows will be dropped`);
    }

    for (let i = 0; i < f.transactions.length; i++) {
      const tx = f.transactions[i];
      const rowFid = i === 0 ? fid : `${fid}-${i + 1}`;
      const txDate = tx.txDate || `${String(cutoff).slice(0,4)}-${String(cutoff).slice(4,6)}-${String(cutoff).slice(6,8)}`;

      process.stdout.write(`  → ${item.id}${i > 0 ? `.${i + 1}` : ''} ${(company || '?').slice(0, 28).padEnd(28)} ${tx.txType.padEnd(7)} ${tx.shares} @ ${tx.pricePerShare} SGD  ${txDate}\n`);

      dbRows.push({
        filing_id: rowFid,
        country_code: COUNTRY_CODE,
        ticker,
        company,
        insider_name: f.insiderName || null,
        via_entity: f.viaEntity || null,
        insider_role: f.role,
        transaction_type: tx.txType,
        transaction_date: txDate,
        shares: tx.shares,
        price_per_share: tx.pricePerShare,
        total_value: tx.totalValue,
        currency: CURRENCY,
        filing_url: item.url,
        source: SOURCE,
      });
    }

    await new Promise((r) => setTimeout(r, 300)); // be polite to links.sgx.com
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const buys = dbRows.filter((r) => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter((r) => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${elapsed}s — ${dbRows.length} rows processed (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeSG().catch((err) => { console.error('❌ Fatal:', err.message); process.exit(1); });
