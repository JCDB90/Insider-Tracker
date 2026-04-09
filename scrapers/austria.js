/**
 * AT — Insider Transactions Scraper
 *
 * Source: FMA Austria
 * URL: https://www.fma.gv.at/en/managers-transactions/
 *
 * FMA Austria — page protected by Cloudflare. Needs Puppeteer with stealth. Alternative: Wien Börse.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'AT';
const SOURCE         = 'FMA Austria';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeAT() {
  console.log('🇦🇹  FMA Austria');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: FMA Austria — page protected by Cloudflare. Needs Puppeteer with stealth. Alternative: Wien Börse.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.fma.gv.at/en/managers-transactions/
  // Alternative: https://www.wienerborse.at/en/news-information/news-overview/

  console.log('  ⚠  Scraper not yet implemented for AT.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeAT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
