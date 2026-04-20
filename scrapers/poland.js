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

const https      = require('https');
const { execSync } = require('child_process');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');
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

function getBinary(url, _redirects = 3) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://www.gpw.pl/komunikaty',
      },
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects > 0) {
        res.resume();
        return done(getBinary(res.headers.location, _redirects - 1));
      }
      // Abort immediately if server sends HTML (not a PDF)
      const ct = res.headers['content-type'] || '';
      if (ct.includes('text/html')) { res.destroy(); return done(null); }
      const chunks = [];
      res.on('data', c => {
        chunks.push(c);
        // Also abort if first bytes aren't PDF magic
        if (chunks.length === 1 && c.length >= 4 && c.slice(0,4).toString() !== '%PDF') {
          res.destroy();
          done(null);
        }
      });
      res.on('end', () => done(Buffer.concat(chunks)));
    });
    req.on('error', () => done(null));
    req.setTimeout(10000, () => { req.destroy(); done(null); });
  });
}

function pdfBufToText(buf) {
  if (!buf || buf.length < 100) return null;
  const tmp = path.join(os.tmpdir(), `pl_esma_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    return execSync(`/usr/bin/pdftotext -layout "${tmp}" -`, { timeout: 15000 }).toString('utf8') || null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Extract shares+price from ESMA MAR form PDF text (same format as DK)
function parseEsmaPdfText(text) {
  if (!text) return {};
  // Price+Volume table line: "PLN 5.00                         1000" or "DKK/EUR/PLN X  N,NNN"
  const priceVolLine = text.match(/(?:PLN|EUR|USD|GBP|SEK|NOK|CHF|DKK)\s+([\d,\.]+)\s{3,}([\d,]+)\s*$/im);
  let shares = null, price = null, totalValue = null;
  if (priceVolLine) {
    const pv = parseFloat(priceVolLine[1].replace(/,/g, ''));
    const sv = parseFloat(priceVolLine[2].replace(/,/g, ''));
    if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
    if (!isNaN(pv) && pv > 0) price = pv;
  }
  // Aggregated total before "— Price" label
  const totalM = text.match(/(?:PLN|EUR|USD)\s*([\d\s,\.]+)\s*\n[^\n]*—\s*Price/im);
  if (totalM) {
    const t = parseFloat(totalM[1].replace(/[\s,]/g, ''));
    if (!isNaN(t) && t > 0) totalValue = Math.round(t);
  }
  // Aggregated volume fallback
  if (!shares) {
    const aggVol = text.match(/Aggregated\s+volume\s+([\d,]+)/im)
      || text.match(/Agregowana\s+wielko\S+\s+([\d,]+)/im)  // Polish
      || text.match(/Aggregated\b[^\n]*\n[^\n]*\n\s*([\d,]+)/im);
    if (aggVol) {
      const sv = parseFloat(aggVol[1].replace(/,/g, ''));
      if (!isNaN(sv) && sv > 0) shares = Math.round(sv);
    }
  }
  // Price from "Unit price: X PLN" or "Jednostkowa cena: X"
  if (!price) {
    const priceM = text.match(/(?:Unit\s+price|Cena\s+jednostkowa)[^\d]*([\d,\.]+)\s*(?:PLN|EUR|USD)/i);
    if (priceM) {
      const n = parseFloat(priceM[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) price = n;
    }
  }
  // Derive missing: total or price from shares
  if (shares && price && !totalValue) totalValue = Math.round(shares * price);
  if (shares && totalValue && !price) price = parseFloat((totalValue / shares).toFixed(4));

  return { shares, price, totalValue };
}

/**
 * Parse the GPW ESPI detail page HTML for structured fields.
 * Returns { insiderName, role, shares, price, totalValue } — all can be null if not parseable.
 *
 * GPW ESPI report body text (Polish):
 *   "Pani Magdalena Krupa nabyła ... 1448 akcji ... za łączną kwotę 64 970,20 PLN. Średnia cena za 1 akcję wyniosła 44,87 PLN."
 *   "od Pana Witolda Grabysza - Wiceprezesa Zarządu Spółki"
 *   "przez Waldemara Lipkę - Prezesa Zarządu Emitenta"
 *   English: "from Mr. Vatnak Vat-Ho - Member of the Management Board"
 *
 * Note: GPW attachment URLs return HTML (require browser session), so PDF parsing is not used.
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
  let totalValue = null;

  // ─── Name + role extraction ───────────────────────────────────────────────

  // 1. English: "from Mr./Ms. [Name] - [Role]"
  const enNameM = text.match(
    /from\s+(?:Mr\.|Ms\.|Mrs\.)?\s*([A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘA-Z][a-zA-ZÀ-ž\-]+){1,4})\s*[-–]\s*((?:Member|President|Chairman|Chief|Director|Vice|Head|Officer)[^,\.\n]{2,60})/i
  );
  if (enNameM) {
    insiderName = enNameM[1].trim();
    role = enNameM[2].replace(/\s+(?:of\s+the\s+(?:Company|Management Board|Supervisory Board)|Spółki|Emitenta)\s*$/, '').trim();
  }

  // 2. Nominative from verb: "Pan/Pani [Firstname Lastname] nabył/nabyła/zbył/zbyła"
  // Note: no \b after verb — Polish chars like 'ł' are non-ASCII and break JS \b
  if (!insiderName) {
    const verbM = text.match(
      /Pan[ia]?\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+)\s+(?:nabył|nabyła|zbył|zbyła|sprzedał|sprzedała)/u
    );
    if (verbM) insiderName = verbM[1].trim();
  }

  // 3. Polish genitive: "od Pana/Pani [Name] - [Role]" (name in genitive case)
  if (!insiderName) {
    const plOdM = text.match(
      /od\s+Pan\w*\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u
    );
    if (plOdM) {
      insiderName = plOdM[1].trim();
      role = plOdM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim();
    }
  }

  // 4. Polish: "Panem/Panią [Name] - [Role]"
  if (!insiderName) {
    const plPanM = text.match(
      /Pan(?:em|ią)\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u
    );
    if (plPanM) {
      insiderName = plPanM[1].trim();
      role = plPanM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA|i\s+Panią|oraz)\b.*$/, '').trim();
    }
  }

  // 5. Polish accusative: "przez [Name] - [Role]"
  if (!insiderName) {
    const plPrzezM = text.match(
      /przez\s+([A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+(?:\s+[A-ZŁŚĆŹŻÓĄĘ][a-złśćźżóąę\-]+){1,3})\s*[-–]\s*([^,\.\n]{3,80})/u
    );
    if (plPrzezM) {
      insiderName = plPrzezM[1].trim();
      role = plPrzezM[2].replace(/\s+(?:Spółki|Emitenta|S\.A\.|SA)\b.*$/, '').trim();
    }
  }

  // ─── Shares ───────────────────────────────────────────────────────────────

  // 1. Delta from before/after (Polish): "posiadał X akcji ... posiada Y akcji" — most reliable
  const plSharesM = text.match(/posiada[łl]a?\s+([\d\s]+)\s+akcji.*?posiada\s+([\d\s]+)\s+akcji/i);
  if (plSharesM) {
    const before = parseInt(plSharesM[1].replace(/\s/g, ''), 10);
    const after  = parseInt(plSharesM[2].replace(/\s/g, ''), 10);
    if (!isNaN(before) && !isNaN(after) && before !== after) shares = Math.abs(before - after);
  }

  // 2. Delta from before/after (English): "held X shares ... holds Y shares"
  if (!shares) {
    const enSharesM = text.match(/held\s+([\d,\s]+)\s+shares.*?holds?\s+([\d,\s]+)\s+shares/i);
    if (enSharesM) {
      const before = parseInt(enSharesM[1].replace(/[,\s]/g, ''), 10);
      const after  = parseInt(enSharesM[2].replace(/[,\s]/g, ''), 10);
      if (!isNaN(before) && !isNaN(after) && before !== after) shares = Math.abs(before - after);
    }
  }

  // 3. Explicit transaction context: "nabył/zbył X akcji" or "łączna kwota ... X akcji"
  if (!shares) {
    const txSharesM = text.match(/(?:nabył|nabyła|zbył|zbyła|sprzedał|sprzedała|transakcj\w*\s+(?:nabycia|zbycia)[^.]{0,60}?)\s+([\d][\d\s]{0,10})\s+akcji/iu);
    if (txSharesM) {
      const n = parseInt(txSharesM[1].replace(/\s/g, ''), 10);
      if (!isNaN(n) && n > 0) shares = n;
    }
  }

  // 4. Fallback: first bare "X akcji" in transaction sentence (nabycie/zbycie context)
  if (!shares) {
    const sharesDirectM = text.match(/\b([\d][\d\s]{0,10})\s+akcji\b/u);
    if (sharesDirectM) {
      const n = parseInt(sharesDirectM[1].replace(/\s/g, ''), 10);
      if (!isNaN(n) && n > 0) shares = n;
    }
  }

  // ─── Price ────────────────────────────────────────────────────────────────

  // "Średnia cena za 1 akcję wyniosła X PLN" or "cena jednostkowa X PLN"
  const avgPriceM = text.match(
    /(?:Średnia\s+cena\s+za\s+1\s+akcję|cena\s+jednostkowa|kurs\s+(?:nabycia|zbycia)|po\s+cenie|po\s+kursie|cenie\s+nabycia)[^\d]*([\d\s,]+)\s*(?:PLN|zł|złotych)/i
  );
  if (avgPriceM) {
    const n = parseFloat(avgPriceM[1].replace(/\s/g, '').replace(',', '.'));
    if (!isNaN(n) && n > 0) price = n;
  }

  // ─── Total ────────────────────────────────────────────────────────────────

  // "za łączną kwotę X PLN" or "łączna wartość X PLN"
  const totalM = text.match(
    /(?:za\s+łączną\s+kwotę|łączna\s+(?:wartość|kwota|cena))[^\d]*([\d\s,]+)\s*(?:PLN|zł|złotych)/i
  );
  if (totalM) {
    const n = parseFloat(totalM[1].replace(/\s/g, '').replace(',', '.'));
    if (!isNaN(n) && n > 0) totalValue = Math.round(n);
  }

  // Derive price from total+shares if missing
  if (!price && totalValue && shares && shares > 0) {
    price = parseFloat((totalValue / shares).toFixed(4));
  }

  // ─── Transaction type from body text ─────────────────────────────────────
  // Note: no trailing \b — Polish chars (ł, ą etc.) are non-ASCII and break JS \b
  // Cover verbs (nabył/nabyła) AND noun forms (nabycia/nabyciem/nabyciem/sprzedaż/sprzedażą etc.)
  let txType = null;
  // Check SELL first (more specific signals), then BUY as fallback
  if (
    /zbył|zbyła|zbyto|sprzedał|sprzedała|sprzeda[żz]|zbyci[ae]|zbyciem|zbycie/.test(text) ||
    /\bsold\b|\bdisposed\b|\bdisposal\b/i.test(text)
  ) txType = 'SELL';
  else if (
    /nabył|nabyła|nabyto|kupił|kupiła|nabywał|nabywała|nabyci[ae]|nabyciem|nabycie/.test(text) ||
    /objął|objęcia\s+akcji|objęcia\s+udzia|subskrypcj/.test(text) ||  // subscription
    /otrzymali?\s+\S+\s+akcji|otrzymali?\s+akcji/.test(text) ||        // received shares
    /\bacquired\b|\bpurchased\b|\bbought\b|\breceived\s+shares\b/i.test(text)
  ) txType = 'BUY';

  return { insiderName, role, shares, price, totalValue, txType };
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
    let parsedTxType = null;
    if (r.geruId) {
      const detailHtml = await fetchDetailHtml(r.geruId);
      const parsed = parseDetailPage(detailHtml);
      insiderName  = parsed.insiderName;
      role         = parsed.role;
      shares       = parsed.shares;
      price        = parsed.price;
      totalValue   = parsed.totalValue;
      parsedTxType = parsed.txType;
      await new Promise(res => setTimeout(res, DELAY_MS));
    }

    // Prefer body-text txType (more reliable), fall back to title keywords
    const txType = parsedTxType || mapType(r.title);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.isin,
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
