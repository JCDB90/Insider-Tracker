/**
 * ZA — Insider Transactions Scraper
 *
 * Source: JSE South Africa
 * URL: https://www.jse.co.za/services/market-data/company-news
 *
 * JSE SENS (Securities Exchange News Service) — director dealings published as SENS announcements.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'ZA';
const SOURCE         = 'JSE South Africa';
const RETENTION_DAYS = 14;
const CURRENCY       = 'ZAR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeZA() {
  console.log('🇿🇦  JSE South Africa');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: JSE SENS (Securities Exchange News Service) — director dealings published as SENS announcements.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.jse.co.za/services/market-data/company-news
  // SENS search: https://senspdf.jse.co.za/ — filter by announcement type "Director Dealings"

  console.log('  ⚠  Scraper not yet implemented for ZA.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeZA().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
