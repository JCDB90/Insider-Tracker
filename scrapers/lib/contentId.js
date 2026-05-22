'use strict';
/**
 * Content-based filing ID generator.
 *
 * Produces a stable 16-char hex ID from the transaction's natural key fields.
 * Same transaction always → same ID regardless of when/how it was scraped.
 * Enables upsert deduplication for scrapers whose source IDs are positional
 * (e.g. FSMA BE-umicore-116 shifts to BE-umicore-124 on the next run).
 *
 * Key fields: country + company + insider + txType + date + shares + price
 * Including txType prevents collisions when the same insider buys AND sells
 * the identical amount at the identical price on the same day (rare but real).
 */

const crypto = require('crypto');

/**
 * @param {string} country   - ISO country code, e.g. 'BE'
 * @param {string} company   - company name
 * @param {string} insider   - insider name (null/undefined → '')
 * @param {string} txType    - 'BUY' | 'SELL' | 'OTHER'
 * @param {string} date      - ISO date, e.g. '2026-05-13'
 * @param {number|null} shares
 * @param {number|null} price
 * @returns {string}  16-char hex digest prefixed with country code, e.g. 'BE-a1b2c3d4e5f60708'
 */
function contentId(country, company, insider, txType, date, shares, price) {
  const key = [
    country   || '',
    (company  || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    (insider  || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    (txType   || '').toUpperCase(),
    date      || '',
    shares    != null ? String(Math.round(shares)) : '',
    price     != null ? String(price) : '',
  ].join('|');

  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 16);
  return `${country}-${hash}`;
}

module.exports = { contentId };
