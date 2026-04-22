'use strict';

const https = require('https');

/**
 * Fetch closing price for a ticker on a specific date from Yahoo Finance.
 * Tries Euronext Amsterdam (.AS), Paris (.PA), Frankfurt (.DE), London (.L), and bare ticker.
 * Returns null if not found.
 */
function fetchYahooClose(symbol, dateStr) {
  return new Promise(resolve => {
    const base = new Date(dateStr + 'T12:00:00Z');
    const period1 = Math.floor(base.getTime() / 1000);
    const period2 = period1 + 7 * 86400; // look forward 7 days to handle weekends/holidays

    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
          if (!closes || closes.length === 0) return resolve(null);
          const price = closes.find(p => p != null && p > 0);
          resolve(price ? Math.round(price * 10000) / 10000 : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Get closing price for a ticker on a date.
 * Tries multiple exchange suffixes automatically.
 * @param {string} ticker - e.g. "ASML", "INGA", "BAYN"
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} [exchange] - hint: 'NL', 'FR', 'DE', 'GB', etc.
 * @returns {Promise<number|null>}
 */
async function getClosePrice(ticker, dateStr, exchange = '') {
  if (!ticker || !dateStr) return null;

  // Exchange-specific suffix priority
  const EXCHANGE_SUFFIXES = {
    NL: ['.AS', '.PA', ''],
    FR: ['.PA', '.AS', ''],
    DE: ['.DE', '.F', ''],
    GB: ['.L', ''],
    SE: ['.ST', ''],
    DK: ['.CO', ''],
    FI: ['.HE', ''],
    NO: ['.OL', ''],
    BE: ['.BR', '.PA', ''],
    PT: ['.LS', ''],
    IT: ['.MI', ''],
    ES: ['.MC', ''],
    AT: ['.VI', ''],
    CH: ['.SW', ''],
    PL: ['.WA', ''],
    LU: ['.LU', ''],
  };

  const suffixes = EXCHANGE_SUFFIXES[exchange] || ['', '.AS', '.PA', '.DE', '.L', '.ST'];

  for (const suffix of suffixes) {
    const symbol = ticker + suffix;
    const price = await fetchYahooClose(symbol, dateStr);
    if (price) return price;
    await new Promise(r => setTimeout(r, 200)); // gentle rate-limit
  }
  return null;
}

/**
 * Get close price N days offset from a base date.
 * Positive offset = days after base date; negative = days before.
 * @param {string} ticker
 * @param {string} baseDateStr - YYYY-MM-DD
 * @param {number} offsetDays  - e.g. -30 for 30 days before, +30 for after
 * @param {string} countryCode
 * @returns {Promise<number|null>}
 */
async function getClosePriceAtOffset(ticker, baseDateStr, offsetDays, countryCode) {
  if (!ticker || !baseDateStr) return null;
  const base = new Date(baseDateStr + 'T12:00:00Z');
  base.setDate(base.getDate() + offsetDays);
  const targetStr = base.toISOString().slice(0, 10);
  return getClosePrice(ticker, targetStr, countryCode);
}

/**
 * Fetch multiple prices in one call over a date range. Returns an array of
 * { date, price } objects. Useful for getting 7d/30d/90d from one request.
 * @param {string} symbol  - Yahoo Finance symbol (e.g. "ASML.AS")
 * @param {string} fromStr - YYYY-MM-DD (inclusive)
 * @param {string} toStr   - YYYY-MM-DD (inclusive)
 * @returns {Promise<Array<{date:string, price:number}>>}
 */
function fetchYahooRange(symbol, fromStr, toStr) {
  return new Promise(resolve => {
    const p1 = Math.floor(new Date(fromStr + 'T00:00:00Z').getTime() / 1000);
    const p2 = Math.floor(new Date(toStr   + 'T23:59:59Z').getTime() / 1000);
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve([]);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const result = data?.chart?.result?.[0];
          const timestamps = result?.timestamp || [];
          const closes = result?.indicators?.adjclose?.[0]?.adjclose
                      || result?.indicators?.quote?.[0]?.close || [];
          const out = [];
          for (let i = 0; i < timestamps.length; i++) {
            const price = closes[i];
            if (price != null && price > 0) {
              const d = new Date(timestamps[i] * 1000);
              out.push({
                date:  d.toISOString().slice(0, 10),
                price: Math.round(price * 10000) / 10000,
              });
            }
          }
          resolve(out);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
  });
}

/**
 * Find the closest available trading-day price on or after targetDate within
 * the provided sorted array of { date, price } objects.
 */
function findClosestPrice(priceData, targetDateStr) {
  if (!priceData || priceData.length === 0) return null;
  // Prefer exact match, then nearest after, then nearest before
  const exact = priceData.find(p => p.date === targetDateStr);
  if (exact) return exact.price;
  // Nearest after (up to 7 calendar days)
  const after = priceData.find(p => p.date >= targetDateStr);
  if (after) {
    const diff = (new Date(after.date) - new Date(targetDateStr)) / 86400000;
    if (diff <= 7) return after.price;
  }
  // Nearest before (up to 7 calendar days)
  const before = [...priceData].reverse().find(p => p.date <= targetDateStr);
  if (before) {
    const diff = (new Date(targetDateStr) - new Date(before.date)) / 86400000;
    if (diff <= 7) return before.price;
  }
  return null;
}

module.exports = { getClosePrice, getClosePriceAtOffset, fetchYahooRange, findClosestPrice };
