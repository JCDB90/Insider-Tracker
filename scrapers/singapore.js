/**
 * SG — Insider Transactions Scraper
 *
 * Source: SGX Singapore
 * URL: https://www.sgx.com/securities/company-announcements
 *
 * SGX company announcements — insider dealings filed as Form 5. SGX has a search API.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'SG';
const SOURCE         = 'SGX Singapore';
const RETENTION_DAYS = 14;
const CURRENCY       = 'SGD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeSG() {
  console.log('🇸🇬  SGX Singapore');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: SGX company announcements — insider dealings filed as Form 5. SGX has a search API.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.sgx.com/securities/company-announcements
  // SGX API: https://api.sgx.com/securities/v1.0/announcements?category=insider-dealings

  console.log('  ⚠  Scraper not yet implemented for SG.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeSG().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
