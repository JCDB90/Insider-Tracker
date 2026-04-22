'use strict';

/**
 * Maps country codes to Yahoo Finance exchange suffixes.
 * Also provides specific overrides for tickers that need special handling.
 */

const COUNTRY_SUFFIX = {
  AT: '.VI',  BE: '.BR',  CA: '.TO',  CH: '.SW',  CZ: '.PR',
  DE: '.DE',  DK: '.CO',  ES: '.MC',  FI: '.HE',  FR: '.PA',
  GB: '.L',   HK: '.HK',  IE: '.IR',  IT: '.MI',  JP: '.T',
  KR: '.KS',  LU: '.LU',  NL: '.AS',  NO: '.OL',  PL: '.WA',
  PT: '.LS',  SE: '.ST',  SG: '.SI',  ZA: '.JO',
};

// ticker overrides keyed as "TICKER|COUNTRY" → Yahoo symbol
const SPECIFIC_OVERRIDES = {
  'BARC|GB':   'BARC.L',
  'BP|GB':     'BP.L',
  'SHEL|GB':   'SHEL.L',
  'HSBA|GB':   'HSBA.L',
  'AZN|GB':    'AZN.L',
  'GSK|GB':    'GSK.L',
  'LSEG|GB':   'LSEG.L',
  'FLOW|NL':   'FLOW.AS',
  'PRX|NL':    'PRX.AS',
  'ASML|NL':   'ASML.AS',
  'INGA|NL':   'INGA.AS',
  'RDSA|NL':   'SHELL.AS',
  'VID|ES':    'VID.MC',
  'REP|ES':    'REP.MC',
  'IBE|ES':    'IBE.MC',
  'THEP|FR':   'THEP.PA',
  'MC|FR':     'MC.PA',
  'OR|FR':     'OR.PA',
  'JEN|BE':    'JEN.BR',
};

/**
 * Convert a local ticker to Yahoo Finance format.
 * Returns the Yahoo-format symbol, or null if country unknown.
 */
function toYahooTicker(ticker, countryCode) {
  if (!ticker || !countryCode) return ticker || null;
  const override = SPECIFIC_OVERRIDES[`${ticker}|${countryCode}`];
  if (override) return override;
  const suffix = COUNTRY_SUFFIX[countryCode];
  if (!suffix) return ticker; // US or unknown — use bare ticker
  return `${ticker}${suffix}`;
}

/**
 * Return the list of Yahoo suffixes to try for a country (in priority order).
 * Used by getClosePrice when trying multiple suffixes.
 */
function getSuffixesForCountry(countryCode) {
  const primary = COUNTRY_SUFFIX[countryCode];
  if (!primary) return [''];
  // Some markets have secondary venues worth trying
  const extras = {
    NL: ['.AS', '.PA'],
    BE: ['.BR', '.PA'],
    DE: ['.DE', '.F'],
    FR: ['.PA', '.AS'],
    GB: ['.L'],
    CH: ['.SW'],
  };
  return extras[countryCode] || [primary];
}

module.exports = { toYahooTicker, getSuffixesForCountry, COUNTRY_SUFFIX };
