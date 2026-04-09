/**
 * KR — Insider Transactions Scraper
 *
 * Source: DART South Korea
 * URL: https://opendart.fss.or.kr/api/majorstock.json
 *
 * DART (Data Analysis Retrieval and Transfer) has a free JSON API. Requires free API key from opendart.fss.or.kr.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'KR';
const SOURCE         = 'DART South Korea';
const RETENTION_DAYS = 90;
const CURRENCY       = 'KRW';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeKR() {
  console.log('🇰🇷  DART South Korea');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: DART (Data Analysis Retrieval and Transfer) has a free JSON API. Requires free API key from opendart.fss.or.kr.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://opendart.fss.or.kr/api/majorstock.json
  // Set DART_API_KEY env var. Register at https://opendart.fss.or.kr/intro/main.do

  console.log('  ⚠  Scraper not yet implemented for KR.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeKR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
