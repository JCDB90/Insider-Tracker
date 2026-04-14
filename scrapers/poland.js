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

const https  = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

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

// ─── Fetch GPW detail page for richer data ────────────────────────────────────

function fetchDetailHtml(geruId) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'www.gpw.pl',
      path: `/komunikat?geru_id=${geruId}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9',
        'Referer': 'https://www.gpw.pl/komunikaty',
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
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Parse the GPW ESPI detail page HTML for structured fields.
 * Returns { insiderName, role, shares, price } — all can be null if not parseable.
 *
 * GPW ESPI report body text patterns:
 *   Polish: "od Pana Witolda Grabysza - Wiceprezesa Zarządu Spółki"
 *           "przez Waldemara Lipkę - Prezesa Zarządu Emitenta"
 *   English: "from Mr. Vatnak Vat-Ho - Member of the Management Board"
 *
 * Names in Polish are in genitive/accusative case.
 * English version (if present) gives nominative form — prefer it.
 */
function parseDetailPage(html) {
  if (!html) return {};

  // Focus on the "Treść raportu" section to avoid false positives from nav text
  const reportStart = html.indexOf('Treść raportu');
  const section = reportStart > -1 ? html.slice(reportStart, reportStart + 12000) : html;
  const text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  let insiderName = null;
  let role = null;
  let shares = null;
  let price = null;

  // ─── 1. English section: "from Mr./Ms. [Name] - [Role] of the Company"
  const enNameM = text.match(
    /from\s+(?:Mr\.|Ms\.|Mrs\.)?\s*([A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+){1,4})\s*[-–]\s*((?:Member|President|Chairman|Chief|Director|Vice|Head|Officer)[^,\.\n]{2,60})/i
  );
  if (enNameM) {
    insiderName = enNameM[1].trim();
    role = enNameM[2].replace(/\s+(?:of\s+the\s+(?:Company|Management Board|Supervisory Board)|Spółki|Emitenta)\s*$/, '').trim();
  }

  // ─── 2. Polish: "od Pana/Pani [Name] - [Role]"  (Pana = gen. of Pan = Mr.)
  if (!insiderName) {
    const plOdM = text.match(
      /od\s+Pan\w*\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u
    );
    if (plOdM) {
      insiderName = plOdM[1].trim();
      role = plOdM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim();
    }
  }

  // ─── 3. Polish: "przez [Name] - [Role]"
  if (!insiderName) {
    const plPrzezM = text.match(
      /przez\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u
    );
    if (plPrzezM) {
      insiderName = plPrzezM[1].trim();
      role = plPrzezM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim();
    }
  }

  // ─── Shares: delta from before/after holdings ─────────────────────────────
  // English: "held X,000 shares ... holds Y,000 shares"
  const enSharesM = text.match(/held\s+([\d,\s]+)\s+shares.*?holds?\s+([\d,\s]+)\s+shares/i);
  if (enSharesM) {
    const before = parseInt(enSharesM[1].replace(/[,\s]/g, ''), 10);
    const after  = parseInt(enSharesM[2].replace(/[,\s]/g, ''), 10);
    if (!isNaN(before) && !isNaN(after) && before !== after) shares = Math.abs(before - after);
  }

  // Polish: "posiadał(a) X akcji ... posiada Y akcji"
  if (!shares) {
    const plSharesM = text.match(/posiada[łl]a?\s+([\d\s]+)\s+akcji.*?posiada\s+([\d\s]+)\s+akcji/i);
    if (plSharesM) {
      const before = parseInt(plSharesM[1].replace(/\s/g, ''), 10);
      const after  = parseInt(plSharesM[2].replace(/\s/g, ''), 10);
      if (!isNaN(before) && !isNaN(after) && before !== after) shares = Math.abs(before - after);
    }
  }

  // ─── Price: "po cenie/kursie X zł/PLN" (present in HTML for some filings)
  const priceM = text.match(/(?:po\s+cenie|po\s+kursie|cenie\s+nabycia)\s+([\d\s,]+)\s*(?:zł|PLN|złotych)/i);
  if (priceM) {
    const n = parseFloat(priceM[1].replace(/\s/g, '').replace(',', '.'));
    if (!isNaN(n) && n > 0) price = n;
  }

  return { insiderName, role, shares, price };
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

  // Fetch each detail page to get insider name, shares, price
  console.log(`  Fetching detail pages for ${insiderItems.length} insider reports…`);

  const seen = new Set();
  const dbRows = [];
  for (const r of insiderItems) {
    const fid = `PL-${r.geruId || (r.company + '-' + r.txIso).replace(/\s/g, '_')}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    let insiderName = null, role = null, shares = null, price = null;
    if (r.geruId) {
      const detailHtml = await fetchDetailHtml(r.geruId);
      const parsed = parseDetailPage(detailHtml);
      insiderName = parsed.insiderName;
      role        = parsed.role;
      shares      = parsed.shares;
      price       = parsed.price;
      await new Promise(res => setTimeout(res, DELAY_MS));
    }

    const txType = mapType(r.title);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin,
      company:          r.company,
      insider_name:     insiderName || 'Company Officer',
      insider_role:     translateRole(role),
      transaction_type: txType,
      transaction_date: r.txIso,
      shares,
      price_per_share:  price,
      total_value:      (shares && price) ? Math.round(shares * price) : null,
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
