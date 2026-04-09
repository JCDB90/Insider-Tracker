/**
 * PL — Insider Transactions Scraper
 *
 * Source: KNF Poland
 * URL: https://espi.knf.gov.pl/
 *
 * KNF ESPI system — HTML-only, per-filing search. Alternatively use GPW (Warsaw Stock Exchange) announcements.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'PL';
const SOURCE         = 'KNF Poland';
const RETENTION_DAYS = 14;
const CURRENCY       = 'PLN';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapePL() {
  console.log('🇵🇱  KNF Poland');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: KNF ESPI system — HTML-only, per-filing search. Alternatively use GPW (Warsaw Stock Exchange) announcements.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://espi.knf.gov.pl/
  // Alternative: https://www.gpw.pl/komunikaty?type=MAR

  console.log('  ⚠  Scraper not yet implemented for PL.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapePL().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
