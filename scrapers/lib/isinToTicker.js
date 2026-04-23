'use strict';

const https = require('https');

// In-process cache — avoids duplicate lookups within a single scraper run
const cache = new Map();

const COUNTRY_SUFFIX = {
  AT: '.VI', BE: '.BR', CA: '.TO', CH: '.SW', CZ: '.PR',
  DE: '.DE', DK: '.CO', ES: '.MC', FI: '.HE', FR: '.PA',
  GB: '.L',  HK: '.HK', IE: '.IR', IT: '.MI', JP: '.T',
  KR: '.KS', LU: '.LU', NL: '.AS', NO: '.OL', PL: '.WA',
  PT: '.LS', SE: '.ST', SG: '.SI', ZA: '.JO',
};

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
 * or null if not found. Uses an in-process cache.
 */
async function isinToTicker(isin, countryCode) {
  if (!isin) return null;

  const key = `${isin}|${countryCode || ''}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&lang=en-US&type=equity`;
    const data = await fetchJson(url);
    await new Promise(r => setTimeout(r, 200)); // gentle rate limit

    const quotes = (data && data.quotes) || [];
    const equities = quotes.filter(q => q.quoteType === 'EQUITY' && q.symbol);

    if (!equities.length) { cache.set(key, null); return null; }

    const suffix = countryCode ? (COUNTRY_SUFFIX[countryCode] || '') : '';

    // Prefer symbol from the country's primary exchange
    let match = equities.find(q => suffix && q.symbol.endsWith(suffix));
    if (!match) match = equities[0];

    // Strip exchange suffix to get base ticker
    const symbol = match.symbol;
    let base = symbol;
    // Try all known suffixes + common extras not in COUNTRY_SUFFIX
    const allSuffixes = [...Object.values(COUNTRY_SUFFIX), '.SG', '.NZ', '.AX', '.BK', '.JK', '.NS', '.BO', '.SR'];
    for (const sfx of allSuffixes) {
      if (symbol.endsWith(sfx)) { base = symbol.slice(0, -sfx.length); break; }
    }

    // Reject if base still contains a dot (unstripped suffix) or looks like an ISIN
    if (base.includes('.') || /^[A-Z]{2}[A-Z0-9]{10}$/.test(base)) {
      cache.set(key, null);
      return null;
    }

    cache.set(key, base);
    return base;
  } catch {
    cache.set(key, null);
    return null;
  }
}

module.exports = { isinToTicker };
