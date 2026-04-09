/**
 * CZ — Insider Transactions Scraper
 *
 * Source: CNB Czech Republic
 * URL: https://www.cnb.cz/en/supervision-financial-market/trading-market/
 *
 * CNB — insider transactions in CZ published via PSE (Prague Stock Exchange) announcements system.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'CZ';
const SOURCE         = 'CNB Czech Republic';
const RETENTION_DAYS = 14;
const CURRENCY       = 'CZK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeCZ() {
  console.log('🇨🇿  CNB Czech Republic');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: CNB — insider transactions in CZ published via PSE (Prague Stock Exchange) announcements system.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.cnb.cz/en/supervision-financial-market/trading-market/
  // Alternative: https://www.pse.cz/en/company-filings

  console.log('  ⚠  Scraper not yet implemented for CZ.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeCZ().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
