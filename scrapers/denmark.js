/**
 * DK — Insider Transactions Scraper
 *
 * Source: Finanstilsynet Denmark
 * URL: https://www.finanstilsynet.dk/markedsover-vaagning/insidere
 *
 * Danish FSA insider register — URL may need verification. Check disclosure.finanstilsynet.dk
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'DK';
const SOURCE         = 'Finanstilsynet Denmark';
const RETENTION_DAYS = 90;
const CURRENCY       = 'DKK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeDK() {
  console.log('🇩🇰  Finanstilsynet Denmark');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: Danish FSA insider register — URL may need verification. Check disclosure.finanstilsynet.dk
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.finanstilsynet.dk/markedsover-vaagning/insidere
  // Alternative: https://offentliggoerelse.finanstilsynet.dk/

  console.log('  ⚠  Scraper not yet implemented for DK.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeDK().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
