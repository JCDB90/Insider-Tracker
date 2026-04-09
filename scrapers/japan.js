/**
 * JP — Insider Transactions Scraper
 *
 * Source: EDINET Japan FSA
 * URL: https://disclosure.edinet-api.go.jp/api/v2/documents.json
 *
 * EDINET public API — no auth needed. DocType 36 = insider trading report (特定有価証券等開示府令).
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'JP';
const SOURCE         = 'EDINET Japan FSA';
const RETENTION_DAYS = 90;
const CURRENCY       = 'JPY';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

async function scrapeJP() {
  console.log('🇯🇵  EDINET Japan FSA');
  const t0 = Date.now();
  const co = cutoff();

  // TODO: EDINET public API — no auth needed. DocType 36 = insider trading report (特定有価証券等開示府令).
  // Implement HTTP scraping or Puppeteer for this market.
  // Regulatory portal: https://disclosure.edinet-api.go.jp/api/v2/documents.json
  // API: ?date=YYYY-MM-DD&type=2 then filter by ordinanceCode=010 docTypeCode=36

  console.log('  ⚠  Scraper not yet implemented for JP.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeJP().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
