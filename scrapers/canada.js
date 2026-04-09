/**
 * CA — Insider Transactions Scraper
 *
 * Source: SEDI Canada — System for Electronic Disclosure by Insiders
 * URL: https://www.sedi.ca/sedibin/gipo_title.en
 *
 * SEDI is operated by the CSA (Canadian Securities Administrators). It provides
 * a public search interface for insider transactions. The SEDI website is protected
 * by ShieldSquare/PerformDrive bot detection — all programmatic requests receive
 * a 302 redirect to a bot challenge page.
 *
 * Alternative: The CSA also publishes SEDAR+ filings at https://www.sedarplus.ca/
 * Insider transactions (Form 55-102F2) are filed as SEDI reports.
 *
 * To enable: implement Puppeteer automation to bypass ShieldSquare challenge,
 * or use a compliant data provider with SEDI API access.
 *
 * SEDI Form fields: issuer name, ISIN/CUSIP, insider name, date, type,
 *   number of securities, average price, total value
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'CA';
const SOURCE         = 'SEDI Canada';
const RETENTION_DAYS = 14;
const CURRENCY       = 'CAD';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function trySedi(from, to) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'www.sedi.ca',
      path: `/sedibin/gipo_title.en`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'en-CA,en;q=0.9',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        // ShieldSquare challenge detected
        if (res.statusCode === 302 || d.includes('perfdrive.com') || d.includes('shieldsquare')) {
          return resolve('bot-challenge');
        }
        resolve(res.statusCode === 200 ? d : null);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeCA() {
  console.log('🇨🇦  SEDI Canada — insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const result = await trySedi(from, to);
  if (result === 'bot-challenge') {
    console.log('  ⚠  SEDI redirects to ShieldSquare bot challenge (browser automation required).');
    console.log('  ℹ  Portal: https://www.sedi.ca/sedibin/gipo_title.en');
    console.log('  ℹ  To enable: implement Puppeteer to solve the JS challenge, then POST search form.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }
  if (!result) {
    console.log('  ⚠  SEDI not accessible.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  // If we reach here, we have HTML — parse the SEDI search results
  // (This branch executes if SEDI becomes accessible without bot protection)
  console.log('  SEDI accessible — HTML parsing not yet implemented.');
  console.log('  ℹ  0 rows saved.');
  return { saved: 0 };
}

scrapeCA().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
