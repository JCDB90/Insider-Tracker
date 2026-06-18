/**
 * PL — Insider Transactions Scraper
 *
 * Source: Bankier.pl public API (aggregates PAP/ESPI data)
 * Endpoint: https://api.bankier.pl/quotes/public/insiders-table/
 *
 * Bankier.pl is Poland's largest financial portal (Ringier Axel Springer).
 * It parses PAP/ESPI MAR Art.19 filings and exposes them as structured JSON,
 * delivering all required fields: name, role, type, shares, price, value, date.
 *
 * Field mapping:
 *   symbol            → ticker / company identifier
 *   isin              → ISIN
 *   name              → insider name (Polish ESPI format: Surname Firstname or Surname, Firstname)
 *   insider_function  → role
 *   extra_info        → via_entity (holding company name, when trade is via entity)
 *   transaction_type  → kupno→BUY, sprzedaż→SELL, przejęcie→BUY, inna→drop
 *   shares_number     → shares
 *   avg_price         → price_per_share
 *   value             → total_value
 *   date_from         → transaction_date (actual trade date)
 *
 * Pagination: offset/limit, stop when results.length < limit.
 * Date filter: date_min / date_max as Unix ms timestamps.
 *
 * Coverage: GPW main market + NewConnect, ~5–8 transactions/day.
 * All buy/sell/przejęcie rows have 99%+ price coverage.
 * 'inna' rows (gifts, inheritance, family foundation transfers) are dropped
 * as they have no market price and represent no commercial transaction.
 */
'use strict';

const https = require('https');
const zlib  = require('zlib');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { getPlCompanyName }        = require('./lib/tickerMap');

const COUNTRY_CODE   = 'PL';
const CURRENCY       = 'PLN';
const SOURCE         = 'Bankier.pl (PAP/ESPI MAR Art. 19)';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '3');
const LIMIT          = 100;
const API_BASE       = 'https://api.bankier.pl/quotes/public/insiders-table/';

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.bankier.pl/gielda/transakcje-insiderow',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const parse = (b) => {
          try { resolve(JSON.parse(b.toString('utf8'))); }
          catch { resolve(null); }
        };
        if (enc === 'gzip') zlib.gunzip(buf, (e, d) => parse(e ? buf : d));
        else parse(buf);
      });
    })
    .on('error', () => resolve(null))
    .setTimeout(20000, function() { this.destroy(); resolve(null); });
  });
}

// ─── Field transformers ───────────────────────────────────────────────────────

/**
 * Bankier returns names in Polish ESPI convention — surname first.
 * Two formats observed:
 *   "Kowalski Maciej"            (no comma, 2 words)
 *   "Książek, Mariusz Wojciech"  (comma separator)
 * Convert to "Firstname Surname" Western order.
 */
function formatName(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s.includes(',')) {
    // "Surname, Firstname [Middlename]" → "Firstname [Middlename] Surname"
    const [surname, given] = s.split(',').map(p => p.trim());
    return given ? `${given} ${surname}` : surname;
  }
  const words = s.split(/\s+/);
  if (words.length === 2) {
    // "Surname Firstname" → "Firstname Surname"
    return `${words[1]} ${words[0]}`;
  }
  // 3+ words without comma: can't reliably determine surname boundary — keep as-is
  return s;
}

/**
 * Map Bankier transaction type to BUY / SELL / null.
 * 'inna' = other (gifts, inheritance, foundation transfers) — no market price, drop.
 */
function mapType(raw) {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t === 'kupno' || t === 'nabycie' || t === 'przejęcie') return 'BUY';
  if (t === 'sprzedaż' || t === 'sprzedaz' || t === 'zbycie') return 'SELL';
  return null; // 'inna' and any future unknown types
}

/**
 * Build a stable filing_id from available fields.
 * There is no native filing ID in the API; this combination is effectively unique.
 */
function filingId(item) {
  const name = (item.name || '').replace(/[^a-zA-Z]/g, '').substring(0, 12).toUpperCase();
  const type = (item.transaction_type || '').substring(0, 4).toUpperCase();
  return `PL-BNK-${item.isin || 'X'}-${name}-${item.date_from || 'X'}-${type}`;
}

// ─── Company name resolution ──────────────────────────────────────────────────

const nameCache = new Map(); // ticker → company name, per-run cache

/**
 * Resolve full company name for a GPW ticker.
 * Checks static map first; falls back to fetching the Bankier company page.
 */
async function resolveCompanyName(ticker) {
  const staticName = getPlCompanyName(ticker);
  if (staticName) return staticName;
  if (nameCache.has(ticker)) return nameCache.get(ticker);

  // Dynamic lookup via Bankier page title
  try {
    const name = await new Promise(resolve => {
      https.get(`https://www.bankier.pl/inwestowanie/profile/quote.html?symbol=${encodeURIComponent(ticker)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8');
          const m = html.match(/<title>([^<]+)<\/title>/);
          if (m) {
            const nameMatch = m[1].match(/^(.+?)\s*\(/);
            if (nameMatch) return resolve(nameMatch[1].trim());
          }
          resolve(null);
        });
      }).on('error', () => resolve(null)).setTimeout(10000, function() { this.destroy(); resolve(null); });
    });
    nameCache.set(ticker, name);
    return name;
  } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapePL() {
  console.log('🇵🇱  Bankier.pl — insider transactions (MAR Art. 19)');
  const t0  = Date.now();
  const now = t0;
  const from = now - RETENTION_DAYS * 86400000;

  console.log(`  Window: last ${RETENTION_DAYS} days (${new Date(from).toISOString().slice(0,10)} → ${new Date(now).toISOString().slice(0,10)})`);

  const allItems = [];
  let offset = 0;
  let page = 0;

  while (true) {
    const url = `${API_BASE}?offset=${offset}&limit=${LIMIT}&date_min=${from}&date_max=${now}`;
    const data = await fetchJson(url);

    if (!data) {
      if (page === 0) {
        console.log('  ⚠  Bankier API not accessible.');
        return { saved: 0 };
      }
      break;
    }

    const items = data.results || [];
    console.log(`  Page ${page + 1}: ${items.length} rows (total available: ${data.count})`);
    allItems.push(...items);

    if (items.length < LIMIT) break;
    offset += LIMIT;
    page++;

    await new Promise(r => setTimeout(r, 150));
  }

  if (!allItems.length) {
    console.log('  No transactions in window.');
    return { saved: 0 };
  }

  // Pre-resolve company names for all unique tickers (static map first, Bankier page fallback)
  const uniqueTickers = [...new Set(allItems.map(i => i.symbol).filter(Boolean))];
  const companyNames  = {};
  for (const sym of uniqueTickers) {
    companyNames[sym] = await resolveCompanyName(sym);
  }

  const seen = new Set();
  const dbRows = [];
  let dropped = { inna: 0, noPrice: 0, noShares: 0, dup: 0 };

  for (const item of allItems) {
    const txType = mapType(item.transaction_type);
    if (!txType) { dropped.inna++; continue; }

    const shares = item.shares_number;
    const price  = item.avg_price;
    const total  = item.value;

    if (!shares || shares <= 0) { dropped.noShares++; continue; }
    if (!price  || price  <= 0) { dropped.noPrice++;  continue; }

    const fid = filingId(item);
    if (seen.has(fid)) { dropped.dup++; continue; }
    seen.add(fid);

    // When name is null, Bankier puts the person name in extra_info (entity slot swapped)
    const insiderName = formatName(item.name) || formatName(item.extra_info) || null;
    const role        = item.insider_function || null;
    const viaEntity   = item.name ? (item.extra_info || null) : null;

    const ticker  = item.symbol || '';
    const company = companyNames[ticker] || ticker; // full name, falling back to ticker

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company,
      insider_name:     insiderName,
      insider_role:     translateRole(role),
      via_entity:       viaEntity,
      transaction_type: txType,
      transaction_date: item.date_from,
      shares,
      price_per_share:  price,
      total_value:      total ? Math.round(total) : Math.round(shares * price),
      currency:         CURRENCY,
      filing_url:       `https://www.bankier.pl/gielda/transakcje-insiderow`,
      source:           SOURCE,
    });
  }

  console.log(`  Fetched ${allItems.length} rows → ${dbRows.length} usable (dropped: ${dropped.inna} inna, ${dropped.noPrice} no-price, ${dropped.noShares} no-shares, ${dropped.dup} dup)`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error, drops } = await saveInsiderTransactions(dbRows, { allowPartial: false });
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s — ${dbRows.length} rows passed to DB (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapePL().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
