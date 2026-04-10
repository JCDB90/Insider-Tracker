/**
 * PL — Insider Transactions Scraper
 *
 * Source: GPW Warsaw (Giełda Papierów Wartościowych) via ajaxindex.php
 * URL: https://www.gpw.pl/komunikaty
 * AJAX: POST https://www.gpw.pl/ajaxindex.php
 *
 * Polish MAR Article 19 notifications are filed via ESPI (Elektroniczny System
 * Przekazywania Informacji) as "Bieżący" (current) ESPI reports.
 *
 * The GPW does not expose a dedicated MAR/insider category filter — all ESPI
 * reports are mixed together. Insider transaction notifications are identified
 * by keyword patterns in the report title:
 *   - "zarządcze" (managerial duties)
 *   - "art. 19 MAR" / "art.19 MAR"
 *   - "powiadomien" (notification) + "transakcj" (transaction)
 *   - "nabycie akcji przez" (share acquisition by)
 *   - "obowiązki zarządcze" (managerial responsibilities)
 *   - "osoby blisko związanej" (closely associated person)
 *
 * The AJAX endpoint (ajaxindex.php) returns HTML <li> items sorted newest-first.
 * Pagination via offset. Date stops when all items are older than cutoff.
 *
 * ISIN: appears in parentheses after company name, e.g. PLGRPRC00015
 * Transaction date: approximate (filing date, not actual trade date)
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'PL';
const SOURCE         = 'GPW Warsaw / ESPI (MAR Art. 19)';
const RETENTION_DAYS = 14;
const CURRENCY       = 'PLN';
const PAGE_SIZE      = 200;
const MAX_PAGES      = 10;
const DELAY_MS       = 300;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(title) {
  if (!title) return 'UNKNOWN';
  const l = title.toLowerCase();
  if (l.includes('nabyci') || l.includes('zakup') || l.includes('nabycie') ||
      l.includes('kupno') || l.includes('opcj') || l.includes('subskrypcj')) return 'BUY';
  if (l.includes('zbyci') || l.includes('sprzedaż') || l.includes('sprzedaz') ||
      l.includes('zbycie') || l.includes('odpła')) return 'SELL';
  return 'OTHER';
}

// Keywords that identify MAR Article 19 insider transaction notifications
const INSIDER_KEYWORDS = [
  'zarządcz',          // zarządcze (managerial)
  'art. 19 mar',       // art. 19 MAR
  'art.19 mar',
  'artykuł 19 mar',
  'rozporządzenia mar',
  'obowiązki zarząd',  // managerial responsibilities
  'osoby blisko',      // closely associated person
  'powiadomien.*transakcj',   // notification of transaction
  'transakcj.*zarządcz',      // transaction by manager
  'transakcj.*osoby',         // transaction by person
  'nabycie akcji przez',      // share acquisition by
  'zbycie akcji przez',       // share disposal by
  'nabycie.*prezes',          // acquisition by CEO
  'zbycie.*prezes',
  'nabycie.*członk',          // acquisition by board member
];

function isInsiderReport(title) {
  const l = title.toLowerCase();
  for (const kw of INSIDER_KEYWORDS) {
    if (new RegExp(kw, 'i').test(l)) return true;
  }
  return false;
}

function fetchPage(offset) {
  return new Promise((resolve) => {
    const body = Buffer.from(
      `action=GPWEspiReportUnion&start=ajaxSearch&page=komunikaty&format=html&lang=PL&letter=&offset=${offset}&limit=${PAGE_SIZE}&categoryRaports[]=ESPI&typeRaports[]=RB`
    );

    const req = https.request({
      hostname: 'www.gpw.pl',
      path: '/ajaxindex.php',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.gpw.pl/komunikaty',
        'Origin': 'https://www.gpw.pl',
        'Content-Length': body.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function parseItems(html) {
  // Parse <li> items from the ajaxindex response
  const items = [];
  const liRe = /<li[^>]*style[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const li = m[1];

    // Date: "10-04-2026 11:18:21 | Bieżący | ESPI | 18/2026"
    const dateM = li.match(/(\d{2}-\d{2}-\d{4})\s+\d{2}:\d{2}:\d{2}/);
    if (!dateM) continue;
    const dateParts = dateM[1].split('-');  // DD-MM-YYYY
    const txIso = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

    // Company name + ISIN: "SPÓŁKA (PLXXXXXXXXXX)"
    const nameM = li.match(/href="komunikat\?[^"]+">([^<]+)<\/a>/);
    const companyRaw = nameM ? nameM[1].trim() : null;
    let company = companyRaw;
    let isin = '';
    if (companyRaw) {
      const isinM = companyRaw.match(/\(([A-Z]{2}[A-Z0-9]{10})\)/);
      if (isinM) {
        isin = isinM[1];
        company = companyRaw.replace(/\s*\([^)]+\)\s*$/, '').trim();
      }
    }

    // Title from <p>
    const titleM = li.match(/<p>\s*([\s\S]*?)\s*<\/p>/);
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : '';

    // Filing URL
    const urlM = li.match(/href="(komunikat\?geru_id=\d+[^"]*)"/);
    const filingUrl = urlM ? `https://www.gpw.pl/${urlM[1]}` : 'https://www.gpw.pl/komunikaty';

    // Report ID
    const geruM = li.match(/geru_id=(\d+)/);
    const geruId = geruM ? geruM[1] : null;

    items.push({ txIso, company, isin, title, filingUrl, geruId });
  }
  return items;
}

async function scrapePL() {
  console.log('🇵🇱  GPW Warsaw — ESPI insider transactions (MAR Art. 19)');
  const t0  = Date.now();
  const co  = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} (ESPI bieżące, filtering for MAR Art. 19)…`);

  const allItems = [];
  const seenIds  = new Set();
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await new Promise(r => setTimeout(r, DELAY_MS));

    const html = await fetchPage(offset);
    if (!html) {
      if (page === 0) {
        console.log('  ⚠  GPW ajaxindex.php not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }

    const items = parseItems(html);
    if (!items.length) break;

    let allBefore = true;
    for (const item of items) {
      if (item.txIso >= from) {
        allBefore = false;
        const id = item.geruId || `${item.company}-${item.txIso}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allItems.push(item);
        }
      }
    }

    console.log(`  Offset ${offset}: ${items.length} items, ${allItems.length} in window`);
    if (allBefore) { console.log('  All items before cutoff, stopping.'); break; }
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (!allItems.length) {
    console.log('  No ESPI reports in window.');
    return { saved: 0 };
  }

  // Filter for insider transaction reports
  const insiderItems = allItems.filter(item => isInsiderReport(item.title));
  console.log(`  ${allItems.length} total reports → ${insiderItems.length} MAR Art. 19 insider reports`);

  if (!insiderItems.length) {
    console.log('  No insider transaction reports found.');
    return { saved: 0 };
  }

  const seen = new Set();
  const dbRows = [];
  for (const r of insiderItems) {
    const fid = `PL-${r.geruId || (r.company + '-' + r.txIso).replace(/\s/g, '_')}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin,
      company:          r.company,
      insider_name:     null,   // not in list view; in report PDF
      insider_role:     null,
      transaction_type: mapType(r.title),
      transaction_date: r.txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       r.filingUrl,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  const other = dbRows.filter(r => r.transaction_type === 'OTHER').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL, ${other} OTHER)`);
  return { saved: dbRows.length };
}

scrapePL().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
