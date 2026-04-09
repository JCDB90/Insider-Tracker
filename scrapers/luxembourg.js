/**
 * LU — Insider Transactions Scraper
 *
 * Source: CSSF Luxembourg
 * URL: https://www.cssf.lu/en/supervision/capital-markets/
 *
 * CSSF — LU insider transactions go through Bourse de Luxembourg or Luxembourg Stock Exchange.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'LU';
const SOURCE         = 'CSSF Luxembourg';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeLU() {
  console.log('🇱🇺  CSSF Luxembourg');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: CSSF — LU insider transactions go through Bourse de Luxembourg or Luxembourg Stock Exchange.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.cssf.lu/en/supervision/capital-markets/
  // Try: https://www.bourse.lu/home/trading/market-information/company-news

  console.log('  ⚠  Scraper not yet implemented for LU.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeLU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
