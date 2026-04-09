/**
 * FI — Insider Transactions Scraper
 *
 * Source: Finanssivalvonta Finland
 * URL: https://www.finanssivalvonta.fi/en/listed-companies/market-abuse-regulation/managers-transactions/
 *
 * FIN-FSA — disclosures published on Euronext Helsinki or Nasdaq Helsinki. Try Nasdaq Nordic.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'FI';
const SOURCE         = 'Finanssivalvonta Finland';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeFI() {
  console.log('🇫🇮  Finanssivalvonta Finland');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: FIN-FSA — disclosures published on Euronext Helsinki or Nasdaq Helsinki. Try Nasdaq Nordic.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.finanssivalvonta.fi/en/listed-companies/market-abuse-regulation/managers-transactions/
  // Alternative: https://www.nasdaqomxnordic.com/news/company_announcements

  console.log('  ⚠  Scraper not yet implemented for FI.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeFI().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
