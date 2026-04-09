/**
 * FR — Insider Transactions Scraper
 *
 * Source: AMF France
 * URL: https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants
 *
 * AMF BDIF register — JS-rendered Struts2 app. Try HTTP pagination first; upgrade to Puppeteer if blocked.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'FR';
const SOURCE         = 'AMF France';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeFR() {
  console.log('🇫🇷  AMF France');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: AMF BDIF register — JS-rendered Struts2 app. Try HTTP pagination first; upgrade to Puppeteer if blocked.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://bdif.amf-france.org/Registre-BDIF/MAR/transactions-dirigeants
  // Table cols: date, emetteur, ISIN, declarant, qualite, nature, qte, prix, montant, devise

  console.log('  ⚠  Scraper not yet implemented for FR.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeFR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
