/**
 * NO — Insider Transactions Scraper
 *
 * Source: Finanstilsynet Norway
 * URL: https://www.finanstilsynet.no/markedstilsyn/innsidehandel/
 *
 * Finanstilsynet insider register — need to find correct data endpoint. Try HTML table pagination.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Finanstilsynet Norway';
const RETENTION_DAYS = 90;
const CURRENCY       = 'NOK';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeNO() {
  console.log('🇳🇴  Finanstilsynet Norway');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: Finanstilsynet insider register — need to find correct data endpoint. Try HTML table pagination.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.finanstilsynet.no/markedstilsyn/innsidehandel/
  // Alternative: https://www.oslobors.no/markedsaktivitet/#/list/insider/quotelist/ob

  console.log('  ⚠  Scraper not yet implemented for NO.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeNO().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
