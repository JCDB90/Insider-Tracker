'use strict';

const https = require('https');

// In-process cache — fast path; also pre-populated from Supabase on first call
const cache = new Map();

const COUNTRY_SUFFIX = {
  AT: '.VI', BE: '.BR', CA: '.TO', CH: '.SW', CZ: '.PR',
  DE: '.DE', DK: '.CO', ES: '.MC', FI: '.HE', FR: '.PA',
  GB: '.L',  HK: '.HK', IE: '.IR', IT: '.MI', JP: '.T',
  KR: '.KS', LU: '.LU', NL: '.AS', NO: '.OL', PL: '.WA',
  PT: '.LS', SE: '.ST', SG: '.SI', ZA: '.JO',
};

// ── Persistent Supabase cache (lazy init) ────────────────────────────────────

let _sb          = null;
let _dbLoaded    = false;
let _dbEnabled   = false;

function _getSupabase() {
  if (_sb) return _sb;
  try {
    const { createClient } = require('@supabase/supabase-js');
    _sb = createClient(
      process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
      process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
    );
  } catch { /* @supabase/supabase-js not available */ }
  return _sb;
}

/** Load all rows from isin_ticker_cache into in-process Map. Call once per process. */
async function _loadDbCache() {
  if (_dbLoaded) return;
  _dbLoaded = true;
  const sb = _getSupabase();
  if (!sb) return;

  let from = 0;
  let total = 0;
  while (true) {
    const { data, error } = await sb
      .from('isin_ticker_cache')
      .select('isin, country_code, ticker')
      .range(from, from + 999);
    if (error) return; // table doesn't exist yet — graceful degradation
    if (!data || data.length === 0) break;
    for (const r of data) {
      const key = `${r.isin}|${r.country_code || ''}`;
      if (!cache.has(key)) cache.set(key, r.ticker ?? null);
    }
    total += data.length;
    if (data.length < 1000) break;
    from += 1000;
  }
  _dbEnabled = true;
}

/** Persist a new resolution to Supabase (fire-and-forget). */
function _dbSave(isin, countryCode, ticker) {
  if (!_dbEnabled) return;
  const sb = _getSupabase();
  if (!sb) return;
  sb.from('isin_ticker_cache')
    .upsert({ isin, country_code: countryCode || '', ticker: ticker ?? null, resolved_at: new Date().toISOString() },
            { onConflict: 'isin,country_code', ignoreDuplicates: false })
    .then(() => {})
    .catch(() => {});
}

// ── Yahoo Finance lookup ─────────────────────────────────────────────────────

function fetchJson(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Look up a ticker symbol for an ISIN using Yahoo Finance search.
 * Returns base ticker without exchange suffix (e.g. "ABI" not "ABI.BR"),
 * or null if not found.
 *
 * Uses a two-level cache:
 *   1. In-process Map (reset each run — fast, zero latency)
 *   2. Supabase isin_ticker_cache table (persistent across runs)
 *
 * New resolutions are saved to Supabase so future runs skip Yahoo for known ISINs.
 */
async function isinToTicker(isin, countryCode) {
  if (!isin) return null;

  // Load Supabase cache on first call
  await _loadDbCache();

  const key = `${isin}|${countryCode || ''}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&lang=en-US&type=equity`;
    const data = await fetchJson(url);
    await new Promise(r => setTimeout(r, 200)); // gentle rate limit

    const quotes = (data && data.quotes) || [];
    const equities = quotes.filter(q => q.quoteType === 'EQUITY' && q.symbol);

    if (!equities.length) {
      cache.set(key, null);
      // Don't persist nulls from Yahoo — could be transient rate-limiting
      return null;
    }

    const suffix = countryCode ? (COUNTRY_SUFFIX[countryCode] || '') : '';

    // Prefer symbol from the country's primary exchange
    let match = equities.find(q => suffix && q.symbol.endsWith(suffix));
    if (!match) match = equities[0];

    // Strip exchange suffix to get base ticker
    const symbol = match.symbol;
    let base = symbol;
    const allSuffixes = [...Object.values(COUNTRY_SUFFIX), '.SG', '.NZ', '.AX', '.BK', '.JK', '.NS', '.BO', '.SR'];
    for (const sfx of allSuffixes) {
      if (symbol.endsWith(sfx)) { base = symbol.slice(0, -sfx.length); break; }
    }

    // Reject if base still contains a dot or looks like an ISIN
    if (base.includes('.') || /^[A-Z]{2}[A-Z0-9]{10}$/.test(base)) {
      cache.set(key, null);
      return null;
    }

    cache.set(key, base);
    _dbSave(isin, countryCode, base); // persist for future runs
    return base;
  } catch {
    cache.set(key, null);
    return null;
  }
}

module.exports = { isinToTicker };
