/**
 * NO — Insider Transactions Scraper
 *
 * Source: Oslo Bors / Euronext Oslo — NewsWeb (newsweb.oslobors.no)
 *
 * The NewsWeb SPA fetches its live API base from /urls.json at runtime:
 *   { "api_large": "https://api3.oslo.oslobors.no" }
 * The compile-time env var (obns-api.dev.euronext.cloud) is a decommissioned
 * dev endpoint — the production API is api3.oslo.oslobors.no.
 *
 * Key API details (found by reverse-engineering the SPA):
 *   POST /v1/newsreader/categories  → returns category list; insider ID is 1102
 *   GET  /v1/newsreader/list?category=1102&fromDate=...&toDate=...  (no market param)
 *   GET  /v1/newsreader/message?messageId=<id>  → body is free-text prose
 *
 * Note: Each transaction is filed twice — Norwegian title first, English second
 * (consecutive IDs, same issuerId + timestamp).  We skip Norwegian-titled
 * messages ("Meldepliktig") because Oslo Bors requires English filings.
 *
 * Body prose format (English):
 *   "John Smith, CEO of Acme Corp, on April 20 purchased 100 shares in
 *    Acme Corp at NOK 50.00 per share. Following..."
 */
'use strict';

const https        = require('https');
const { execFile } = require('child_process');
const os           = require('os');
const path         = require('path');
const fs           = require('fs');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { looksLikeCorp }           = require('./lib/entityUtils');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors / Euronext Oslo';
const RETENTION_DAYS = 90;
const CURRENCY       = 'NOK';
const NEWSWEB_BASE   = 'https://newsweb.oslobors.no';
const API_FALLBACK   = 'https://api3.oslo.oslobors.no';
// Fallback in case POST /categories fails (e.g. API change)
const INSI_CAT_ID_FALLBACK = 1102;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── Number parser (handles NOK "1 234,50" and English "1,234.50") ────────────

function parseNum(s) {
  if (!s && s !== 0) return null;
  const str = String(s).trim().replace(/\s/g, '');   // strip spaces (handles "10 000")
  if (!str) return null;
  // European decimal: 1.234,56 → 1234.56
  if (/\d\.\d{3},\d/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  // Period-thousands (no decimal): 10.000 or 1.234.567 → 10000, 1234567
  if (/^\d{1,3}(\.\d{3})+$/.test(str)) return parseFloat(str.replace(/\./g, ''));
  // American thousands+decimal: 1,234.56 → 1234.56
  if (/\d,\d{3}\./.test(str)) return parseFloat(str.replace(/,/g, ''));
  if (/,/.test(str) && !/\./.test(str)) {
    const parts = str.split(',');
    // Multiple commas: always thousands — "5,496,534" → 5496534
    if (parts.length > 2) return parseFloat(str.replace(/,/g, ''));
    // 3-digit tail: thousands — "138,500" → 138500; "1,234" → 1234
    if (parts[1] && parts[1].length === 3) return parseFloat(str.replace(/,/g, ''));
    // 1-2 or 4-digit tail: decimal — "27,60" → 27.60; "61,7088" → 61.7088
    if (parts[1] && parts[1].length <= 4) return parseFloat(str.replace(',', '.'));
    return parseFloat(str.replace(/,/g, ''));
  }
  return parseFloat(str.replace(/,/g, ''));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const HEADERS = {
  'Accept':  'application/json',
  'Origin':  NEWSWEB_BASE,
  'Referer': `${NEWSWEB_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function getJson(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => resolve(err.code === 'ENOTFOUND' ? 'dns-error' : null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

function postJson(urlStr, body) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => resolve(err.code === 'ENOTFOUND' ? 'dns-error' : null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function getBytes(urlStr, maxBytes = 600000, absoluteMs = 25000) {
  return new Promise(resolve => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; clearTimeout(abortTimer); resolve(val); } };
    // Hard wall-clock timeout — fires even if data is actively flowing (slow large PDFs)
    const abortTimer = setTimeout(() => { req.destroy(); finish(null); }, absoluteMs);
    const u = new URL(urlStr);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS }, res => {
      const chunks = []; let total = 0;
      res.on('data', c => { total += c.length; chunks.push(c); if (total >= maxBytes) { req.destroy(); finish(null); } });
      res.on('end', () => { if (res.statusCode !== 200) return finish(null); finish(Buffer.concat(chunks)); });
      res.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
  });
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function getApiBase() {
  const json = await getJson(`${NEWSWEB_BASE}/urls.json`);
  if (json && json.api_large) return json.api_large.replace(/\/$/, '');
  return API_FALLBACK;
}

async function getInsiCategoryId(apiBase) {
  const cats = await postJson(`${apiBase}/v1/newsreader/categories`);
  if (!cats || cats === 'dns-error') return INSI_CAT_ID_FALLBACK;
  if (!Array.isArray(cats)) return INSI_CAT_ID_FALLBACK;
  const cat = cats.find(c =>
    (c.category_en || '').toLowerCase().includes('manager') ||
    (c.category_no || '').toLowerCase().includes('meldepliktig') ||
    String(c.id) === String(INSI_CAT_ID_FALLBACK)
  );
  return cat?.id ?? INSI_CAT_ID_FALLBACK;
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

async function pdfToText(buffer) {
  const tmp = path.join(os.tmpdir(), `oslo-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
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

/**
 * Parse one MAR Article 19 transaction block extracted from a PDF.
 * Handles both the "clean" format (Borr Drilling) and the multi-column
 * format (Observe Medical) where the name appears in an unusual position.
 * Returns null if the block describes a non-market transaction (grant/RSU/option).
 */
function parsePdfMarBlock(text) {
  const t = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');

  // ── Transaction type ── skip non-market grants/RSU/options
  const txTypeM = t.match(/Nature of the transaction\s*\n+([\s\S]*?)(?=\n\s*\n|\nc\)|\nPrice)/i);
  const txTypeRaw = txTypeM ? txTypeM[1].replace(/\n/g, ' ').trim() : '';
  if (!txTypeRaw) return null;
  if (/\b(grant|award|vest|RSU|PSU|incentive\s+plan|warrant|options?\s+plan)\b/i.test(txTypeRaw)
      && !/\b(purchase|acquisition|sale|sell)\b/i.test(txTypeRaw)) return null;

  // SELL first: "repurchase" contains "purchase"; use word boundary for buy
  const txType = /sale|sell|dispos|tilbakekjøp/i.test(txTypeRaw)   ? 'SELL'
               : /\bpurchase\b|\bpurchased\b|acqui|\bbuy\b/i.test(txTypeRaw) ? 'BUY'
               : null;
  if (!txType) return null;

  // ── Price + shares from aggregated section (4d) — most reliable ──
  let shares = null, price = null, total = null, currency = null;

  const aggM = t.match(/Aggregated(?:\s+information)?[:\s\-•]+([\s\S]*?)(?=\ne\)|\nDate of the transaction|$)/i);
  const agg  = aggM ? aggM[1] : t;

  // "500,000 common shares" / "182 000 shares"
  const sharesM = agg.match(/([\d,. ]+)\s+(?:common\s+)?shares?\b/i);
  if (sharesM) { const n = parseNum(sharesM[1]); if (n > 0) shares = Math.round(n); }

  // "for a total of USD 2,790,900" or "Aggregated price: NOK 196 741,21"
  const totM = agg.match(/\b(NOK|USD|EUR|SEK|DKK|GBP|CHF)\s+([\d,. ]+)/i);
  if (totM) { currency = totM[1].toUpperCase(); total = parseNum(totM[2]); }

  if (total && shares && shares > 0 && total > shares) price = total / shares;

  // Fallback: price directly from 4c table — "CURRENCY DECIMAL" pattern
  if (!price) {
    const priceM = t.match(/\b(NOK|USD|EUR|SEK|DKK|GBP|CHF)\s+([\d]+[.,][\d]+)\b/i);
    if (priceM) { currency = currency || priceM[1].toUpperCase(); price = parseNum(priceM[2]); }
  }

  // ── Date (4e) ──
  let txDate = null;
  const dateSection = (t.match(/Date of the transaction\s*\n+([\s\S]*?)(?=\n\s*\nf\)|\nPlace|$)/i) || [])[1] || '';
  const dateRaw = dateSection.trim();
  const dM = dateRaw.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
          || dateRaw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dM) {
    if (dM[0].includes('-')) txDate = dM[0].slice(0, 10);
    else {
      const mo = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
      txDate = `${dM[3]}-${String(mo[dM[2].toLowerCase()]).padStart(2,'0')}-${String(dM[1]).padStart(2,'0')}`;
    }
  }

  // ── Name ──
  let name = null, role = null;

  // Strategy 1: after "a) Name" (skip any section number like "2" that pdftotext inserts)
  const name1M = t.match(/\ba\)\s*Name\b\s*\n+(?:\d+\s*\n+\s*)?([\w(][^\n]{1,80})/i);
  if (name1M) {
    const c = name1M[1].trim();
    if (!/^(?:Reason for|Details of|Initial notification|\d+$)/i.test(c)) name = c;
  }

  // Strategy 2: position/status block — first line may be entity name (e.g. "Glimt Invest AS")
  const posM = t.match(/Position\/status\s*\n+([\s\S]*?)(?=\nb\)\s*Initial)/i);
  if (posM) {
    const lines = posM[1].split('\n').map(l => l.trim()).filter(Boolean);
    if (!name && lines[0]) {
      const first = lines[0];
      if (!/^(CEO|CFO|COO|CTO|Chair|Director|President|Board|Primary|Close associate|Managing)/i.test(first)) {
        name = first;
        role = lines.slice(1).join(', ').trim() || null;
      } else {
        role = lines[0];
      }
    } else if (!role) {
      role = lines[0] || null;
    }
  }

  // Strategy 3: name appears after "auctioneer, or the / auction monitor" (multi-column layout)
  if (!name) {
    const weirdM = t.match(/(?:auctioneer,?\s+or\s+the|auction\s+monitor)\s*\n+([\w][^\n]{2,60})\n/i);
    if (weirdM) {
      const c = weirdM[1].trim();
      if (/^[A-ZÆØÅ]/.test(c) && !/^(?:a\)|b\)|c\)|d\)|e\)|f\)|Business|LEI|Details|Description|ISIN)/i.test(c)) {
        name = c;
      }
    }
  }

  return { name, role, txType, price: price || null, shares, total, currency, txDate };
}

/**
 * Split PDF text into per-transaction blocks and parse each one.
 * A single PDF often contains multiple transactions (one per insider).
 */
function parsePdfMarBlocks(pdfText) {
  // Split on the repeated "NOTIFICATION OF TRANSACTIONS..." header or "1\n\nDetails of the person"
  const splitRe = /(?=NOTIFICATION OF TRANSACTIONS|(?:^|\n\n)1\s*\n+Details of the person)/i;
  const rawBlocks = pdfText.split(splitRe)
    .filter(b => /Nature of the transaction/i.test(b));

  return rawBlocks
    .map(b => parsePdfMarBlock(b))
    .filter(Boolean);  // null = skipped (grant/option/non-market)
}

// ─── Body parser ──────────────────────────────────────────────────────────────

/**
 * Parse Oslo Bors insider transaction message body (English prose format).
 *
 * Format: "John Smith, CEO of Acme Corp, on April 20 purchased 100 shares
 *          in Acme Corp at NOK 50.00 per share."
 */
function parseBody(raw) {
  if (!raw || typeof raw !== 'string') return {};

  const text = raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

  // ── Transaction type ──
  const txType = (() => {
    const l = text.toLowerCase();
    // BUY: purchased/bought/acquired/subscribed + Norwegian: kjøpte/kjøpt/ervervet/kjøp
    if (/\b(purchased?|bought|acqui|subscri|kjøpte?|kjøpt|ervervet|kjøp|erverv)\b/.test(l)) return 'BUY';
    // SELL: sold/disposed/divested + Norwegian: salg/solgte/solgt/avhendet
    if (/\b(sold?|disposed?|divest|salg|solgte?|solgt|avhendet)\b/.test(l)) return 'SELL';
    return 'OTHER';
  })();

  // ── Shares ──
  let shares = null;
  const sharesM = text.match(/([\d,. ]+)\s+(?:shares?|aksjer?)\b/i);
  if (sharesM) {
    const n = Math.round(parseNum(sharesM[1]));
    if (n > 0) shares = n;
  }

  // ── Price per share ──
  let price = null;
  const priceM =
    // "at (a/an) (volume-weighted average) price of NOK X (per share)"
    text.match(/at\s+(?:a[n]?\s+)?(?:(?:volume[\s-]+weighted\s+)?average\s+)?(?:price\s+of\s+)?(?:NOK|EUR|SEK|DKK|USD|GBP)\s*([\d,.]+)\s*(?:per\s+share|each|per\s+aksje)?/i) ||
    // "NOK X per share"
    text.match(/(?:NOK|EUR|SEK|DKK|USD|GBP)\s*([\d,.]+)\s+per\s+(?:share|aksje)/i) ||
    // "price/consideration/kurs of NOK X"
    text.match(/(?:price|consideration|kurs)\s+(?:of\s+)?(?:NOK|EUR|SEK|DKK|USD|GBP)\s*([\d,.]+)/i) ||
    // "for NOK X per share"
    text.match(/for\s+(?:NOK|EUR|SEK|DKK|USD|GBP)\s*([\d,.]+)\s+per\s+share/i) ||
    // "til kurs NOK X" / "til NOK X per aksje" (Norwegian)
    text.match(/til\s+(?:kurs\s+)?(?:NOK|EUR|SEK|DKK)?\s*([\d,.]+)\s*(?:per\s+aksje|kroner\s+per\s+aksje)?/i) ||
    // "at NUMBER per share" with no currency (e.g. "purchased at 161,44 per share")
    text.match(/\bat\s+([\d]+[.,][\d]+)\s+per\s+(?:share|aksje)\b/i);
  if (priceM) {
    const p = parseNum(priceM[1]);
    if (p && p > 0) price = p;
  }

  // ── Total value ──
  let total = null;
  const totalM =
    text.match(/total\s+(?:value|of|consideration)\s+(?:of\s+)?(?:NOK|EUR|SEK|DKK)?\s*([\d,.]+)/i) ||
    text.match(/(?:verdi|value)\s*[:\-]\s*(?:NOK|EUR|SEK|DKK)?\s*([\d,.]+)/i);
  if (totalM) {
    const t = parseNum(totalM[1]);
    if (t && t > 0) total = Math.round(t);
  }
  if (!total && shares && price) total = Math.round(shares * price);

  // ── Insider name, role & via_entity ──
  let insiderName = null;
  let viaEntity   = null;
  let role = null;

  // Table format: "Innsider/Insider: Name"
  const tableNameM =
    text.match(/(?:Innsider|Insider)\s*[:/]\s*([A-ZÆØÅ][^\n|<,]{2,59}?)(?:\s{2,}|\s*(?:Stilling|Position))/i) ||
    text.match(/(?:Innsider|Insider)\s*[:/]\s*([A-ZÆØÅ][a-zA-ZÆØÅæøå\- ]{2,59})/i);
  const tableRoleM =
    text.match(/(?:Stilling|Position)\s*[:/]\s*([A-ZÆØÅ][^\n|<]{2,59}?)(?:\s{2,}|\s*(?:Type|Antall|Kurs|Innsider))/i) ||
    text.match(/(?:Stilling|Position)\s*[:/]\s*([A-ZÆØÅ][a-zA-ZÆØÅæøå \/\-]{2,59})/i);

  if (tableNameM) {
    insiderName = tableNameM[1].trim();
    role = tableRoleM ? tableRoleM[1].trim() : null;
  } else {
    // Prose format — strip legal/boilerplate headers before extracting name
    let prose = text;
    // Strip "NOT FOR PUBLICATION..." legal disclaimer header
    prose = prose.replace(/^NOT\s+FOR\s+PUBLICATION[^.]*\.\s*/i, '');
    // Strip date header: "(April 10, 2026 - Oslo)" — parenthesized form, [^)]* is safe here
    prose = prose.replace(/^\(\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}[^)]*\)\s*[-–]?\s*/i, '');
    // Strip plain date: "April 20, 2026 " or "April 20 2026: "
    prose = prose.replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}[:\s–-]{0,5}/i, '');
    prose = prose.replace(/^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}[:\s]*/i, '');
    // Strip location header: "Frøya, Norway, 20 April 2026: " or "Singapore, 14 April 2026 "
    prose = prose.replace(/^[A-Z][a-zæøåÆØÅ]{2,20}(?:,\s*[A-Z][a-z]{2,20})?,?\s*\d{1,2}\s+[A-Z][a-z]+\s+\d{4}[:\s–-]*/i, '');
    // Strip "Company – " prefix before the person's name (e.g., "Endúr ASA – Jeppe Raaholt...")
    prose = prose.replace(/^[A-Z][a-zA-ZÆØÅ\s\.]{2,40}\s*[–—-]+\s*/u, '');

    const roleKW = 'CEO|CFO|COO|CTO|Chair(?:man)?|Vice|Board|Chief|President|Managing|Senior|General|Member|Director|Officer|Founder|Advisor|Partner|Head|EVP|SVP|VP|Controller|Secretary';

    // ① "Name, ROLE of/in Company..."
    // WORD: single capitalised word, no space within the first char class (prevents matching sentence fragments)
    const WORD = '[A-ZÆØÅ][a-zA-ZÆØÅæøå\\.\\-]{1,25}';
    // No 'i' flag: WORD requires uppercase start, preventing lowercase words like "been",
    // "were", "primary", "informed" from being captured as part of the name.
    const personRoleM = prose.match(
      new RegExp(`(${WORD}(?:\\s+${WORD}){0,4}),\\s*(${roleKW})`)
    );
    if (personRoleM) {
      insiderName = personRoleM[1].trim();
      const afterName = prose.slice(prose.indexOf(personRoleM[0]) + personRoleM[1].length + 1).trim();
      const rolePart = afterName.match(/^([^,]{3,60}?)\s+(?:of|in|i|av)\s+/i);
      role = rolePart ? rolePart[1].trim() : personRoleM[2].trim();
    } else {
      // ② "close associate of [Mr./Mrs./Ms.] Name, Role" — the PDMR is the insider;
      //    the entity filing on their behalf may appear at the start of the prose.
      const closeAssocM = text.match(
        /close\s+associate\s+of\s+(?:Mr\.?\s*|Mrs\.?\s*|Ms\.?\s*)?([A-ZÆØÅ][a-zA-ZÆØÅæøå\- \.]{2,50}(?:\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\-\.]{1,20}){0,3})(?:,|\s+(?:Director|CEO|CFO|Chair|Board|President|Managing|Officer))/i
      );
      if (closeAssocM) {
        insiderName = closeAssocM[1].trim();
        // Capture entity name from prose start: "Kaldvik AS, close associate of..."
        const entityM = prose.match(/^([A-ZÆØÅ][a-zA-ZÆØÅæøå\s\.]{1,50}?(?:AS|ASA|Ltd|LLC|NV|BV|AB|Holding|Invest|Capital|Fund|Trust))\b/);
        if (entityM) viaEntity = entityM[1].trim();
      } else {
        // ③ "controlled by / in which / related party to / primary insider / informed that / published by NAME"
        const controlledByM = text.match(
          new RegExp(`(?:controlled\\s+by|in\\s+which|related\\s+party\\s+(?:to|of)|primary\\s+insider|informed\\s+that|published\\s+by|allocated\\s+to|exercised\\s+by)\\s+(?:Mr\\.?\\s*|Mrs\\.?\\s*|Ms\\.?\\s*)?(${WORD}(?:\\s+${WORD}){0,4})(?:,|\\b)`, 'i')
        );
        if (controlledByM) insiderName = controlledByM[1].trim();
      }
      if (!insiderName) {
        // ④ Fallback: first 2-4 capitalised words before a comma (no space in char class)
        const fallbackM = prose.match(new RegExp(`^(${WORD}(?:\\s+${WORD}){1,3}),`));
        if (fallbackM) insiderName = fallbackM[1].trim();
        const proseRoleM = prose.match(/^[^,]+,\s*([^,]{3,60}?)\s+(?:of|in|i|av)\s+/i);
        if (proseRoleM) role = proseRoleM[1].trim();
      }
    }
  }

  return { txType, insiderName, viaEntity, role, shares, price, total };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeNO() {
  console.log('🇳🇴  Oslo Bors Norway — insider transactions (api3.oslo.oslobors.no)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // Step 1: resolve the live API base URL
  const apiBase = await getApiBase();
  console.log(`  API base: ${apiBase}`);

  // Step 2: get the insider category ID
  const catId = await getInsiCategoryId(apiBase);
  console.log(`  Insider category ID: ${catId}`);

  // Step 3: fetch list
  const listUrl = `${apiBase}/v1/newsreader/list?category=${catId}&fromDate=${from}&toDate=${to}`;
  const listData = await getJson(listUrl);

  if (listData === 'dns-error') {
    console.log('  ⚠  DNS error — Oslo Bors API not reachable. 0 rows saved.');
    return { saved: 0 };
  }
  if (!listData) {
    console.log('  ⚠  List endpoint returned no data. 0 rows saved.');
    return { saved: 0 };
  }

  // API wraps response in { header: {...}, data: { messages: [...] } }
  const payload     = listData.data || listData;
  const allMessages = payload.messages || payload.items || (Array.isArray(listData) ? listData : []);
  console.log(`  Total messages in range: ${allMessages.length}`);

  // Step 4: skip superseded and Norwegian-titled messages
  // Oslo Bors files each transaction in both Norwegian (first) and English (second).
  // We keep only the English version to avoid duplicates.
  const messages = allMessages.filter(m => {
    if ((m.correctedByMessageId || 0) !== 0) return false;   // superseded by correction
    const title = (m.title || '').toLowerCase();
    if (title.includes('meldepliktig') || title.includes('primærinnsidere')) return false;
    return true;
  });
  console.log(`  After filter (English only, skip superseded): ${messages.length} messages`);

  if (!messages.length) {
    console.log('  No messages to process.');
    return { saved: 0 };
  }

  // Step 5: fetch message details and build DB rows
  const dbRows = [];
  const seen   = new Set();
  let detailsFetched = 0;

  for (const m of messages) {
    const msgId   = m.id || m.messageId;
    const fid     = `NO-${msgId}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const txDate  = (m.publishedTime || m.time || m.date || '').slice(0, 10) || from;
    const company = m.issuerName || m.issuerFullName || m.issuer || null;
    const ticker  = m.issuerSign || m.issuerCode || null;

    // Fetch body for parsing
    let parsed = {};
    let msgAttachments = [];
    if (msgId) {
      const msgData = await getJson(`${apiBase}/v1/newsreader/message?messageId=${msgId}`);
      if (msgData && typeof msgData === 'object') {
        const msgObj   = msgData.data?.message || msgData.data || msgData;
        const bodyText = msgObj.body || msgObj.content || msgObj.messageBody || '';
        if (bodyText) parsed = parseBody(bodyText);
        msgAttachments = msgObj.attachments || [];
      }
      detailsFetched++;
      await new Promise(r => setTimeout(r, 100)); // gentle rate-limit
    }

    // Determine transaction type: from body, fall back to title
    const txTypeFromTitle = (() => {
      const t = (m.title || '').toLowerCase();
      if (/\b(kjøp|buy|acqui|purchase)\b/.test(t)) return 'BUY';
      if (/\b(salg|sell|dispos)\b/.test(t)) return 'SELL';
      return 'OTHER';
    })();
    const txType = (parsed.txType && parsed.txType !== 'OTHER') ? parsed.txType : txTypeFromTitle;

    // PDF enrichment: only when body is incomplete AND title doesn't signal a non-market event
    // (RSU/option grants have no market price — skip fetching their PDFs to avoid slow runs)
    const isNonMarketTitle = /\b(RSU|PSU|share\s+option|option\s+grant|incentive\s+plan|vesting|warrant|grant\s+of|right\s+issue|allot)\b/i.test(m.title || '');
    const needsPdf = msgAttachments.length > 0 && !isNonMarketTitle &&
      (parsed.price == null || !parsed.insiderName);

    if (needsPdf) {
      const att = msgAttachments[0];
      const pdfUrl = `${apiBase}/v1/newsreader/attachment?messageId=${msgId}&attachmentId=${att.id}`;
      const pdfBytes = await getBytes(pdfUrl);
      if (pdfBytes && pdfBytes.slice(0, 4).toString() === '%PDF') {
        const pdfText  = await pdfToText(pdfBytes);
        const pdfBlocks = parsePdfMarBlocks(pdfText);
        if (pdfBlocks.length > 0) {
          // Replace the single body-parsed row with one row per PDF transaction block
          // (outer loop already deduped msgId via seen.add(fid), so no seen check needed here)
          for (let i = 0; i < pdfBlocks.length; i++) {
            const b       = pdfBlocks[i];
            const pdfFid  = pdfBlocks.length === 1 ? fid : `${fid}-pdf-${i}`;
            const blkDate = b.txDate || txDate;
            dbRows.push({
              filing_id:        pdfFid,
              country_code:     COUNTRY_CODE,
              ticker,
              company,
              insider_name:     b.name || parsed.insiderName || null,
              via_entity:       (looksLikeCorp(b.name) ? null : (parsed.viaEntity || null)),
              insider_role:     translateRole(b.role || parsed.role) || null,
              transaction_type: b.txType || txType,
              transaction_date: blkDate,
              shares:           b.shares ?? parsed.shares ?? null,
              price_per_share:  b.price  != null ? Math.round(b.price * 10000) / 10000 : (parsed.price ?? null),
              total_value:      b.total  != null ? Math.round(b.total) : (parsed.total ?? null),
              currency:         b.currency || CURRENCY,
              filing_url:       `https://newsweb.oslobors.no/message/${msgId}`,
              source:           SOURCE,
            });
          }
          console.log(`  ⬇  PDF: ${company} (${msgId}) → ${pdfBlocks.length} block(s)`);
          continue; // skip the normal push below
        }
      }
      await new Promise(r => setTimeout(r, 80));
    }

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company,
      insider_name:     parsed.insiderName || null,
      via_entity:       parsed.viaEntity   || null,
      insider_role:     translateRole(parsed.role) || null,
      transaction_type: txType,
      transaction_date: txDate,
      shares:           parsed.shares  ?? null,
      price_per_share:  parsed.price   ?? null,
      total_value:      parsed.total   ?? null,
      currency:         CURRENCY,
      filing_url:       `https://newsweb.oslobors.no/message/${msgId || ''}`,
      source:           SOURCE,
    });
  }

  console.log(`  Fetched ${detailsFetched} message details`);

  if (!dbRows.length) {
    console.log('  Nothing to save.');
    return { saved: 0 };
  }

  // Preview
  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name || '?'} | ${r.transaction_type} | ${r.shares ?? 'n/a'} @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const saved = dbRows.filter(r => r.price_per_share != null && r.price_per_share > 0).length;
  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} rows submitted (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeNO().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
