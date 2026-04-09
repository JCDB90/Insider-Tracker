/**
 * PT — Insider Transactions Scraper
 *
 * Source: CMVM Portugal
 * URL: https://www.cmvm.pt/pt/SDI/Emitentes/Pages/OperacoesComOrganosGestao.aspx
 *
 * CMVM — web portal only, no public bulk API found. May require authenticated session or Puppeteer.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'PT';
const SOURCE         = 'CMVM Portugal';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapePT() {
  console.log('🇵🇹  CMVM Portugal');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: CMVM — web portal only, no public bulk API found. May require authenticated session or Puppeteer.
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://www.cmvm.pt/pt/SDI/Emitentes/Pages/OperacoesComOrganosGestao.aspx
  // Try CMVM XML feed: https://www.cmvm.pt/pt/SDI/API/

  console.log('  ⚠  Scraper not yet implemented for PT.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapePT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
