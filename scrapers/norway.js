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

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

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
  const str = String(s).trim().replace(/\s/g, '');
  if (!str) return null;
  // European: 1.234,56
  if (/\d\.\d{3},\d/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  // American: 1,234.56
  if (/\d,\d{3}\.\d/.test(str)) return parseFloat(str.replace(/,/g, ''));
  // Plain comma decimal: 1234,56
  if (/,/.test(str) && !/\./.test(str)) {
    const parts = str.split(',');
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
    if (/\b(purchased?|bought|acqui|kjøpte?|ervervet|kjøp|erverv|subscri)\b/.test(l)) return 'BUY';
    if (/\b(sold?|disposed?|salg|solgte?|avhendet|divest)\b/.test(l)) return 'SELL';
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
    text.match(/til\s+(?:kurs\s+)?(?:NOK|EUR|SEK|DKK)?\s*([\d,.]+)\s*(?:per\s+aksje|kroner\s+per\s+aksje)?/i);
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

  // ── Insider name & role ──
  let insiderName = null;
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
    // Prose format — strip date/location headers before extracting name
    let prose = text;
    // Strip date header: "April 20, 2026 " or "20 April 2026 "
    prose = prose.replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}[:\s]*/i, '');
    prose = prose.replace(/^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}[:\s]*/i, '');
    // Strip location header: "Frøya, Norway, 20 April 2026: " or "Athens, Greece, 20 April 2026: "
    prose = prose.replace(/^[A-Z][a-zæøåÆØÅ]{2,20}(?:,\s*[A-Z][a-z]{2,20})?,\s*\d{1,2}\s+[A-Z][a-z]+\s+\d{4}[:\s]*/i, '');

    // "Name, CEO/CFO/Director/etc of/in Company..."
    const roleKW = 'CEO|CFO|COO|CTO|Chair(?:man)?|Vice|Board|Chief|President|Managing|Senior|General|Member|Director|Officer|Founder|Advisor|Partner|Head';
    const personRoleM = prose.match(
      new RegExp(`([A-ZÆØÅ][a-zA-ZÆØÅæøå\\- \\.]{2,50}(?:\\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\\-\\.]{1,20}){0,3}),\\s*(${roleKW})`, 'i')
    );
    if (personRoleM) {
      insiderName = personRoleM[1].trim();
      // Role runs from the matched keyword to the next "of"/"in"
      const afterName = prose.slice(prose.indexOf(personRoleM[0]) + personRoleM[1].length + 1).trim();
      const rolePart = afterName.match(/^([^,]{3,60}?)\s+(?:of|in|i|av)\s+/i);
      role = rolePart ? rolePart[1].trim() : personRoleM[2].trim();
    } else {
      // Fallback: first words before comma (as long as they look like a name, not a company)
      const fallbackM = prose.match(/^([A-ZÆØÅ][a-zA-ZÆØÅæøå\- \.]{4,50}(?:\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\-\.]{1,20}){1,3}),/);
      if (fallbackM) insiderName = fallbackM[1].trim();
      const proseRoleM = prose.match(/^[^,]+,\s*([^,]{3,60}?)\s+(?:of|in|i|av)\s+/i);
      if (proseRoleM) role = proseRoleM[1].trim();
    }
  }

  return { txType, insiderName, role, shares, price, total };
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
    if (msgId) {
      const msgData = await getJson(`${apiBase}/v1/newsreader/message?messageId=${msgId}`);
      if (msgData && typeof msgData === 'object') {
        // API wraps: { header: {...}, data: { message: { body: "..." } } }
        const msgObj   = msgData.data?.message || msgData.data || msgData;
        const bodyText = msgObj.body || msgObj.content || msgObj.messageBody || '';
        if (bodyText) parsed = parseBody(bodyText);
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

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           ticker,
      company:          company,
      insider_name:     parsed.insiderName || null,
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
