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
 * by keyword patterns in the report title.
 *
 * The AJAX endpoint (ajaxindex.php) returns HTML <li> items sorted newest-first.
 * Pagination via offset. Date stops when all items are older than cutoff.
 *
 * Parsing strategy: 99% of MAR Art. 19 filings contain the full ESMA standard
 * HTML table on the GPW detail page. The table parser is the primary path; the
 * prose regex fallback handles older free-text filings.
 *
 * ISIN: appears in parentheses after company name, e.g. PLGRPRC00015
 * Transaction date: approximate (filing date, not actual trade date)
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'PL';
const SOURCE         = 'GPW Warsaw / ESPI (MAR Art. 19)';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'PLN';
const PAGE_SIZE      = 200;
const MAX_PAGES      = 50;
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
  'art. 19 ust',       // art. 19 ust. 1 MAR (paragraph variant)
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

// ─── ESMA table parser ────────────────────────────────────────────────────────

/** Polish number format: "24 300,50 PLN" → 24300.50 */
function parsePlNumber(s) {
  if (!s) return null;
  const clean = s
    .replace(/PLN|zł|EUR|USD|GBP|SEK|NOK|DKK/gi, '')
    .replace(/\s/g, '')
    .replace(',', '.')
    .trim();
  const n = parseFloat(clean);
  return (!isNaN(n) && n > 0) ? n : null;
}

/** Map Polish transaction type string → BUY / SELL / null */
function mapPlTxType(s) {
  if (!s) return null;
  const l = s.toLowerCase();
  if (/nabyci|zakup|subskrypcj|objęci|otrzymani/i.test(l)) return 'BUY';
  if (/zbyci|sprzedaż|sprzedaz/i.test(l)) return 'SELL';
  return null;
}

/**
 * Extract all <td> label→value pairs from HTML tables and return a
 * normalised lowercase map.  Handles both 2-column forms (label|value)
 * and ignores header-only rows (no recognisable label).
 */
function extractTableMap(html) {
  const map = {};
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    cellRe.lastIndex = 0;
    let cellM;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(
        cellM[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&oacute;/g, 'ó')
          .replace(/\s+/g, ' ')
          .trim()
      );
    }
    if (cells.length < 2 || !cells[0]) continue;
    const label = cells[0].toLowerCase().replace(/[:\s]+$/, '').trim();
    if (label.length > 80) continue;  // skip rows where "label" is actually body text
    map[label] = cells[1];
    // Also store with abbreviated key for multi-word labels containing a slash
    const slash = label.indexOf('/');
    if (slash > 0) map[label.slice(0, slash).trim()] = cells[1];
  }
  return map;
}

/**
 * Parse the GPW ESPI detail page HTML.
 *
 * Strategy — two passes:
 *   1. ESMA table (primary): extract structured label→value pairs from HTML
 *      tables.  This is the standard format for >99% of Polish MAR Art. 19
 *      filings since ~2020 (identical ESMA form used across all EU markets).
 *   2. Polish prose (fallback): legacy filings that embed data in free text
 *      ("Pan X nabył Y akcji za Z PLN").  Only used when table pass returns
 *      nothing for a given field.
 */
function parseDetailPage(html) {
  if (!html) return {};

  // Narrow to the "Treść raportu" block to avoid picking up navigation HTML
  const reportStart = html.indexOf('Treść raportu');
  const section = reportStart > -1 ? html.slice(reportStart, reportStart + 15000) : html;

  // ── Pass 1: ESMA table ────────────────────────────────────────────────────
  const tbl = extractTableMap(section);

  // Name — multiple label variants used by different issuers
  const insiderNameRaw = (
    tbl['imię i nazwisko'] ||
    tbl['imie i nazwisko'] ||
    tbl['nazwa osoby'] ||
    tbl['osoba fizyczna / prawna'] ||
    tbl['imię i nazwisko / firma'] ||
    tbl['osoba'] || null
  );

  // Role / position
  const roleRaw = (
    tbl['stanowisko'] ||
    tbl['funkcja'] ||
    tbl['pełniona funkcja'] ||
    tbl['stanowisko/status'] ||
    tbl['pełnione obowiązki'] ||
    tbl['stanowisko / status'] || null
  );

  // Transaction type
  const txTypeRaw = (
    tbl['rodzaj transakcji'] ||
    tbl['charakter transakcji'] ||
    tbl['rodzaj'] ||
    tbl['typ transakcji'] || null
  );
  const txTypeFromTable = mapPlTxType(txTypeRaw);

  // Shares (aggregated volume preferred over per-row)
  const sharesRaw = (
    tbl['wolumen łączny'] ||
    tbl['łączna ilość'] ||
    tbl['łączna liczba instrumentów'] ||
    tbl['wolumen'] ||
    tbl['liczba instrumentów'] ||
    tbl['liczba akcji'] ||
    tbl['ilość instrumentów'] || null
  );
  const sharesFromTable = sharesRaw ? Math.round(parsePlNumber(sharesRaw) || 0) || null : null;

  // Price per share
  const priceRaw = (
    tbl['cena jednostkowa'] ||
    tbl['kurs'] ||
    tbl['cena (pln)'] ||
    tbl['cena (waluta)'] ||
    tbl['cena'] || null
  );
  const priceFromTable = parsePlNumber(priceRaw);

  // Total value (aggregated)
  const totalRaw = (
    tbl['łączna wartość transakcji'] ||
    tbl['wartość łączna'] ||
    tbl['wartość transakcji'] ||
    tbl['łączna wartość'] ||
    tbl['łączna suma'] ||
    tbl['wartość'] || null
  );
  const totalFromTable = totalRaw ? Math.round(parsePlNumber(totalRaw) || 0) || null : null;

  // ISIN from table (overrides listing ISIN)
  const isinFromTable = (
    tbl['isin'] ||
    tbl['kod isin'] ||
    tbl['kod identyfikujący instrument'] || null
  );

  let insiderName = insiderNameRaw || null;
  let role        = roleRaw || null;
  let shares      = sharesFromTable;
  let price       = priceFromTable;
  let totalValue  = totalFromTable;
  let txType      = txTypeFromTable;

  // ── Pass 2: Polish prose fallback (name + txType only) ───────────────────
  const text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (!insiderName) {
    // English: "from Mr./Ms. [Name] - [Role]"
    const enM = text.match(
      /from\s+(?:Mr\.|Ms\.|Mrs\.)?\s*([A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+){1,4})\s*[-–]\s*((?:Member|President|Chairman|Chief|Director|Vice|Head|Officer)[^,\.\n]{2,60})/i
    );
    if (enM) { insiderName = enM[1].trim(); if (!role) role = enM[2].trim(); }
  }
  if (!insiderName) {
    // "Pan/Pani Firstname Lastname nabył/nabyła..."
    const verbM = text.match(/Pan[ia]?\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+)\s+(?:nabył|nabyła|zbył|zbyła|sprzedał|sprzedała)/u);
    if (verbM) insiderName = verbM[1].trim();
  }
  if (!insiderName) {
    // "od Pana/Pani [Name] - [Role]"
    const odM = text.match(/od\s+Pan\w*\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u);
    if (odM) { insiderName = odM[1].trim(); if (!role) role = odM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim(); }
  }
  if (!insiderName) {
    // "Panem/Panią [Name] - [Role]" or "przez [Name] - [Role]"
    const panM = text.match(/(?:Pan(?:em|ią)|przez)\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u);
    if (panM) { insiderName = panM[1].trim(); if (!role) role = panM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim(); }
  }

  // Transaction type from prose (only if table didn't provide it)
  if (!txType) {
    if (/zbył|zbyła|zbyto|sprzedał|sprzedała|sprzeda[żz]|zbyci[ae]|zbyciem|\bsold\b|\bdisposal\b/i.test(text)) txType = 'SELL';
    else if (/nabył|nabyła|nabyto|kupił|kupiła|nabyci[ae]|nabyciem|objął|subskrypcj|\bacquired\b|\bpurchased\b/i.test(text)) txType = 'BUY';
  }

  // Shares from prose (fallback — less reliable)
  if (!shares) {
    const plDeltaM = text.match(/posiada[łl]a?\s+([\d\s]+)\s+akcji.*?posiada\s+([\d\s]+)\s+akcji/i);
    if (plDeltaM) {
      const b = parseInt(plDeltaM[1].replace(/\s/g,''),10), a = parseInt(plDeltaM[2].replace(/\s/g,''),10);
      if (!isNaN(b) && !isNaN(a) && b !== a) shares = Math.abs(b-a);
    }
  }
  if (!shares) {
    const txM = text.match(/(?:nabył|nabyła|zbył|zbyła|sprzedał|sprzedała)\s+([\d][\d\s]{0,10})\s+akcji/iu);
    if (txM) { const n = parseInt(txM[1].replace(/\s/g,''),10); if (!isNaN(n)&&n>0) shares=n; }
  }

  // Price from prose (fallback)
  if (!price) {
    const priceM = text.match(/(?:Średnia\s+cena\s+za\s+1\s+akcję|cena\s+jednostkowa|kurs\s+(?:nabycia|zbycia)|po\s+cenie)[^\d]*([\d\s,]+)\s*(?:PLN|zł)/i);
    if (priceM) { const n = parseFloat(priceM[1].replace(/\s/g,'').replace(',','.')); if (!isNaN(n)&&n>0) price=n; }
  }

  // Total from prose (fallback)
  if (!totalValue) {
    const totM = text.match(/(?:za\s+łączną\s+kwotę|łączna\s+(?:wartość|kwota|cena))[^\d]*([\d\s,]+)\s*(?:PLN|zł)/i);
    if (totM) { const n = parseFloat(totM[1].replace(/\s/g,'').replace(',','.')); if (!isNaN(n)&&n>0) totalValue=Math.round(n); }
  }

  // Derive missing financial field
  if (!price && totalValue && shares && shares > 0) price = parseFloat((totalValue / shares).toFixed(4));

  return { insiderName, role, shares, price, totalValue, txType, isinFromTable };
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

    let insiderName = null, role = null, shares = null, price = null, totalValue = null;
    let parsedTxType = null, isinFromTable = null;
    if (r.geruId) {
      const detailHtml = await fetchDetailHtml(r.geruId);
      const parsed = parseDetailPage(detailHtml);
      insiderName   = parsed.insiderName;
      role          = parsed.role;
      shares        = parsed.shares;
      price         = parsed.price;
      totalValue    = parsed.totalValue;
      parsedTxType  = parsed.txType;
      isinFromTable = parsed.isinFromTable;
      await new Promise(res => setTimeout(res, DELAY_MS));
    }

    // Prefer table/body txType, fall back to title keywords
    const txType = parsedTxType || mapType(r.title);
    // Table ISIN overrides listing ISIN (more authoritative source)
    const ticker = isinFromTable || r.isin || '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company:          r.company,
      insider_name:     insiderName || null,
      insider_role:     translateRole(role),
      transaction_type: txType,
      transaction_date: r.txIso,
      shares,
      price_per_share:  price,
      total_value:      totalValue || ((shares && price) ? Math.round(shares * price) : null),
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
