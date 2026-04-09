/**
 * PL — Insider Transactions Scraper
 *
 * Source: KNF Poland (Komisja Nadzoru Finansowego) via ESPI
 * URL: https://espi.knf.gov.pl/
 * Alternative: https://www.gpw.pl/komunikaty (Warsaw Stock Exchange announcements)
 *
 * Polish MAR Article 19 notifications are filed via ESPI (Elektroniczny System
 * Przekazywania Informacji). The ESPI system is web-form only. The GPW
 * (Giełda Papierów Wartościowych) publishes these as company announcements.
 *
 * GPW API for MAR type announcements (type=MAR):
 * https://www.gpw.pl/komunikaty?type=MAR
 * (connection resets from some networks — try with direct HTTP headers)
 *
 * To enable: scrape GPW announcement pages with proper User-Agent and session headers,
 * or implement ESPI form POST automation with Puppeteer.
 */
'use strict';

const https = require('https');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'PL';
const SOURCE         = 'KNF Poland / GPW';
const RETENTION_DAYS = 14;
const CURRENCY       = 'PLN';
const DELAY_MS       = 500;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('nabyci') || l.includes('zakup') || l.includes('acqui') || l.includes('buy')) return 'BUY';
  if (l.includes('zbyci') || l.includes('sprzed') || l.includes('dispos') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

function fetchGpwPage(page, from, to) {
  return new Promise((resolve) => {
    const qs = `type=MAR&dateFrom=${from}&dateTo=${to}&page=${page}`;
    const req = https.get({
      hostname: 'www.gpw.pl',
      path: `/komunikaty?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pl,en;q=0.8',
        'Referer': 'https://www.gpw.pl/',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const $ = cheerio.load(d);
          const rows = [];
          // GPW announcement table
          $('table.tab tbody tr, .komunikat-row, .announcement-row').each((_, tr) => {
            const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
            if (cells.length >= 3) rows.push(cells);
          });
          resolve(rows.length ? rows : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapePL() {
  console.log('🇵🇱  KNF Poland / GPW — MAR insider transactions');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} via GPW komunikaty…`);

  const allRows = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await fetchGpwPage(page, from, to);
    if (!rows) {
      if (page === 1) {
        console.log('  ⚠  GPW kommunikaty not accessible (connection reset or blocked).');
        console.log('  ℹ  ESPI: https://espi.knf.gov.pl/');
        console.log('  ℹ  GPW: https://www.gpw.pl/komunikaty?type=MAR');
        console.log('  ℹ  To enable: fix connection issues or implement Puppeteer for ESPI.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }
    allRows.push(...rows);
    if (rows.length < 20) break;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (!allRows.length) { console.log('  No data.'); return { saved: 0 }; }
  console.log(`  ${allRows.length} raw rows`);

  const seen = new Set();
  const dbRows = [];
  for (const cells of allRows) {
    // Best-effort parsing; column order varies by GPW version
    const txIso    = (cells[0] || '').replace(/(\d{2})\.(\d{2})\.(\d{4})/, '$3-$2-$1').slice(0, 10) || from;
    const company  = cells[1] || null;
    const typeStr  = cells[2] || cells[3] || '';
    const fid      = `PL-${company}-${txIso}-${String(Math.random()).slice(2, 8)}`;
    if (seen.has(fid)) continue; seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           null,
      company,
      insider_name:     cells[3] || null,
      insider_role:     cells[4] || null,
      transaction_type: mapType(typeStr),
      transaction_date: txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       `https://www.gpw.pl/komunikaty?type=MAR`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }
  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  return { saved: dbRows.length };
}

scrapePL().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
