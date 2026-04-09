/**
 * HK — Insider Transactions Scraper
 *
 * Source: HKEX Hong Kong
 * URL: https://www.hkexnews.hk/listedco/listconews/advancedsearch/
 *
 * HKEX Form 3 (director/CEO interests) and substantial shareholder disclosures. Advanced search API.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'HK';
const SOURCE         = 'HKEX Hong Kong';
const RETENTION_DAYS = 90;
const CURRENCY       = 'HKD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeHK() {
  console.log('🇭🇰  HKEX Hong Kong');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: HKEX Form 3 (director/CEO interests) and substantial shareholder disclosures. Advanced search API.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.hkexnews.hk/listedco/listconews/advancedsearch/
  // HKEX search: typecode=3A for director dealings

  console.log('  ⚠  Scraper not yet implemented for HK.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeHK().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
