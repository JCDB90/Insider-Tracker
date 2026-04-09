/**
 * IE — Insider Transactions Scraper
 *
 * Source: CBI Ireland / Euronext Dublin
 * URL: https://www.ise.ie/market-data-announcements/equities/company-announcements/
 *
 * Irish insider transactions published via Euronext Dublin (ISE) company announcements. Filter by MAR.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'IE';
const SOURCE         = 'CBI Ireland / Euronext Dublin';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeIE() {
  console.log('🇮🇪  CBI Ireland / Euronext Dublin');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: Irish insider transactions published via Euronext Dublin (ISE) company announcements. Filter by MAR.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.ise.ie/market-data-announcements/equities/company-announcements/
  // Try: https://direct.euronext.com/Company/Announcements?isin=IE&category=MAR

  console.log('  ⚠  Scraper not yet implemented for IE.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeIE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
