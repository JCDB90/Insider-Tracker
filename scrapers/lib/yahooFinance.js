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

module.exports = { getClosePrice };
