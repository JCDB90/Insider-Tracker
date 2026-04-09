/**
 * IT — Insider Transactions Scraper
 *
 * Source: CONSOB Italy
 * URL: https://www.consob.it/web/guest/-/mar-operazioni
 *
 * CONSOB portal — protected by Radware/Cloudflare. Needs Puppeteer with stealth mode.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'IT';
const SOURCE         = 'CONSOB Italy';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeIT() {
  console.log('🇮🇹  CONSOB Italy');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: CONSOB portal — protected by Radware/Cloudflare. Needs Puppeteer with stealth mode.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.consob.it/web/guest/-/mar-operazioni
  // Table cols: date, emittente, ISIN, soggetto, qualifica, tipo, quantita, prezzo

  console.log('  ⚠  Scraper not yet implemented for IT.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeIT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
