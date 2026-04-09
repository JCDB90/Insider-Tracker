/**
 * CA — Insider Transactions Scraper
 *
 * Source: SEDI Canada
 * URL: https://www.sedi.ca/sedi/SVTItmSrchCrit.php?lang=eng
 *
 * SEDI (System for Electronic Disclosure by Insiders) — public search, no bulk API. Needs form POST.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'CA';
const SOURCE         = 'SEDI Canada';
const RETENTION_DAYS = 14;
const CURRENCY       = 'CAD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeCA() {
  console.log('🇨🇦  SEDI Canada');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: SEDI (System for Electronic Disclosure by Insiders) — public search, no bulk API. Needs form POST.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.sedi.ca/sedi/SVTItmSrchCrit.php?lang=eng
  // SEDI search form accepts issuer name, date range. Returns HTML tables.

  console.log('  ⚠  Scraper not yet implemented for CA.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeCA().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
