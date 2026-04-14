/**
 * NO — Insider Transactions Scraper
 *
 * Source: Oslo Bors / Euronext Oslo — NewsWeb (newsweb.oslobors.no)
 * Backend API: https://obns-api.dev.euronext.cloud/v1/newsreader/list
 *
 * The NewWeb SPA calls the obns-api.dev.euronext.cloud backend for news lists.
 * Category for insider transactions: INSI (Innsidehandel / Insider Trading).
 *
 * API query format:
 *   GET /v1/newsreader/list?category=<cat_id>&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&market=oslo_bors
 *
 * Note: obns-api.dev.euronext.cloud does NOT resolve via public DNS from WSL2.
 * It resolves on GitHub Actions (Azure Linux) and from EU VPS hosts.
 *
 * Transaction details are in PDF attachments; structured data fetched via
 * /v1/newsreader/message?messageId=<id> endpoint.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors Norway / Euronext';
const RETENTION_DAYS = 14;
const CURRENCY       = 'NOK';
const API_HOST       = 'obns-api.dev.euronext.cloud';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('kjøp') || l.includes('erverv') || l.includes('acqui') || l.includes('buy')) return 'BUY';
  if (l.includes('salg') || l.includes('avhend') || l.includes('dispos') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function fetchList(qs) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path: `/v1/newsreader/list?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
        'Referer': 'https://newsweb.oslobors.no/',
      },
    }, res => {
      const ct = res.headers['content-type'] || '';
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200 || !ct.includes('json')) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => {
      if (err.code === 'ENOTFOUND') resolve('dns-error');
      else resolve(null);
    });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch the full message detail for one filing.
 * Oslo Bors insider trade bodies follow a bilingual (NO/EN) table format:
 *   Innsider/Insider: <name>
 *   Stilling/Position: <role>
 *   Type handel/Type of transaction: Kjøp/Buy  or  Salg/Sell
 *   Antall aksjer/Number of shares: <n>
 *   Kurs/Rate: NOK <price>
 *   Verdi/Value: NOK <total>
 */
function fetchMessage(messageId) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path: `/v1/newsreader/message?messageId=${encodeURIComponent(messageId)}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
        'Referer': 'https://newsweb.oslobors.no/',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Parse Oslo Bors insider transaction message body.
 * Handles both Norwegian and English bilingual format used by Euronext Oslo.
 */
function parseMessageBody(body) {
  if (!body || typeof body !== 'string') return {};

  // Normalise: strip HTML tags, collapse whitespace
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  function field(...patterns) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m?.[1]?.trim()) return m[1].trim();
    }
    return null;
  }

  function parseNum(s) {
    if (!s) return null;
    const clean = s.replace(/[,\s]/g, '').replace(/[^\d.]/g, '');
    const n = parseFloat(clean);
    return isNaN(n) ? null : n;
  }

  const nameRaw  = field(
    /(?:Innsider|Insider)\s*[:/]\s*([^\n\r<|,]+?)(?:\s*(?:Stilling|Position|Selskap|Company))/i,
    /(?:Innsider|Insider)\s*[:/]\s*([^\n\r<|]{3,60})/i,
  );
  const roleRaw  = field(
    /(?:Stilling|Position)\s*[:/]\s*([^\n\r<|,]+?)(?:\s*(?:Type|Antall|Kurs|Innsider))/i,
    /(?:Stilling|Position)\s*[:/]\s*([^\n\r<|]{3,60})/i,
  );
  const sharesRaw = field(
    /(?:Antall aksjer|Number of shares)\s*[:/]\s*([\d\s,.]+)/i,
    /(?:Antall|Shares)\s*[:/]\s*([\d\s,.]+)/i,
  );
  const priceRaw  = field(
    /(?:Kurs|Rate|Pris|Price)\s*[:/]\s*(?:NOK\s*)?([\d\s,.]+)/i,
  );
  const totalRaw  = field(
    /(?:Verdi|Value|Total)\s*[:/]\s*(?:NOK\s*)?([\d\s,.]+)/i,
  );

  return {
    insiderName: nameRaw  || null,
    role:        roleRaw  || null,
    shares:      parseNum(sharesRaw),
    price:       parseNum(priceRaw),
    total:       parseNum(totalRaw),
  };
}

function fetchCategories() {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: API_HOST,
      path: '/v1/newsreader/categories',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', err => {
      if (err.code === 'ENOTFOUND') resolve('dns-error');
      else resolve(null);
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeNO() {
  console.log('🇳🇴  Oslo Bors Norway — insider transactions (INSI category)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // First, try to resolve categories to find the INSI category code
  // (falls back to trying 'INSI' directly as category string)
  const cats = await fetchCategories();
  if (cats === 'dns-error') {
    console.log(`  ⚠  Oslo Bors API (${API_HOST}) DNS not resolvable from this network.`);
    console.log(`  ℹ  This API resolves from GitHub Actions and EU VPS — will work in CI.`);
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  // Find INSI category ID (or null if categories unavailable)
  let insiCategoryId = null;
  if (cats && Array.isArray(cats)) {
    const insiCat = cats.find(c =>
      (c.shortName || c.code || c.id || '').toUpperCase() === 'INSI' ||
      (c.name || c.englishName || '').toLowerCase().includes('insider')
    );
    if (insiCat) {
      insiCategoryId = insiCat.id || insiCat.code || insiCat.shortName;
      console.log(`  Found INSI category: ${insiCategoryId}`);
    }
  }

  // Fetch insider transaction list
  const catParam = insiCategoryId || 'INSI';
  const qs = `category=${encodeURIComponent(catParam)}&fromDate=${from}&toDate=${to}&market=oslo_bors`;
  const data = await fetchList(qs);

  if (data === 'dns-error') {
    console.log(`  ⚠  Oslo Bors API DNS not resolvable. 0 rows saved.`);
    return { saved: 0 };
  }
  if (!data) {
    // Try without market filter (may return all Euronext markets)
    console.log(`  First attempt failed — retrying without market filter…`);
    const data2 = await fetchList(`category=${encodeURIComponent(catParam)}&fromDate=${from}&toDate=${to}`);
    if (!data2 || data2 === 'dns-error') {
      console.log('  ⚠  Oslo Bors NewsWeb API returned non-JSON or connection failed.');
      console.log('  ℹ  Portal: https://newsweb.oslobors.no/');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }
  }

  const messages = (data && (data.messages || data.items || (Array.isArray(data) ? data : []))) || [];
  if (!messages.length) {
    console.log('  No INSI messages in window.');
    return { saved: 0 };
  }

  console.log(`  ${messages.length} messages — fetching details…`);
  const seen = new Set();
  const dbRows = [];

  for (const m of messages) {
    const txIso    = (m.time || m.publishedTime || m.date || '').slice(0, 10) || from;
    const msgId    = m.messageId || m.id || null;
    const fid      = `NO-${msgId || (m.issuer + '-' + txIso)}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const txType = mapType(m.messageTitle || m.headline || m.title || '');

    // Fetch message detail to extract body text with insider name / shares / price
    let detail = {};
    if (msgId) {
      const msg = await fetchMessage(msgId);
      if (msg) {
        // Body text can be in msg.body, msg.content, msg.messageBody, or msg.text
        const bodyText = msg.body || msg.content || msg.messageBody || msg.text || '';
        detail = parseMessageBody(bodyText);
      }
      await new Promise(r => setTimeout(r, 200)); // light rate-limit
    }

    const { translateRole } = require('./lib/translate');

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           m.issuer || m.issuerCode || null,
      company:          m.issuerFullName || m.issuerName || m.issuer || null,
      insider_name:     detail.insiderName || 'Not disclosed',
      insider_role:     translateRole(detail.role) || null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           detail.shares   ? Math.round(detail.shares) : null,
      price_per_share:  detail.price    || null,
      total_value:      detail.total    ? Math.round(detail.total)
                      : (detail.shares && detail.price) ? Math.round(detail.shares * detail.price)
                      : null,
      currency:         CURRENCY,
      filing_url:       `https://newsweb.oslobors.no/message/${msgId || ''}`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  // Preview
  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares ?? 'n/a'} @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const withName   = dbRows.filter(r => r.insider_name !== 'Not disclosed').length;
  const withShares = dbRows.filter(r => r.shares !== null).length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${withName} with name, ${withShares} with shares)`);
  return { saved: dbRows.length };
}

scrapeNO().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
