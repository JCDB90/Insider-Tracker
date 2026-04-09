/**
 * AU — Insider Transactions Scraper
 *
 * Source: ASX Australia
 * URL: https://www.asx.com.au/markets/announcements
 *
 * ASX Appendix 3Y (director interest change) filings. Filter company announcements by type=3Y.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'AU';
const SOURCE         = 'ASX Australia';
const RETENTION_DAYS = 90;
const CURRENCY       = 'AUD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeAU() {
  console.log('🇦🇺  ASX Australia');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: ASX Appendix 3Y (director interest change) filings. Filter company announcements by type=3Y.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.asx.com.au/markets/announcements
  // ASX JSON API: https://www.asx.com.au/asx/1/share/{ticker}/announcements?type=3Y

  console.log('  ⚠  Scraper not yet implemented for AU.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeAU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
