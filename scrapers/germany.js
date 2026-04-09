/**
 * Germany (DE) — Insider Transactions Scraper
 *
 * Source: BaFin (Bundesanstalt für Finanzdienstleistungsaufsicht) — MAR Article 19
 * Portal: https://portal.mvp.bafin.de/database/DealingsInfo/
 *
 * Strategy: CSV export (semicolon-delimited) for each letter A-Z.
 * URL: sucheForm.do?d-4000784-e=1&emittentName={X}&6578706f7274=1
 *
 * Available fields from CSV:
 *   ✅ Emittent (company), BaFin-ID, ISIN, Meldepflichtiger (insider),
 *      Position/Status (role), Art des Geschäfts (Kauf/Verkauf),
 *      Durchschnittspreis (avg price), Aggregiertes Volumen (total value),
 *      Datum des Geschäfts (transaction date), Mitteilungsdatum (filing date)
 *
 * Note: BaFin's server sends non-standard HTTP headers that trip up node-fetch.
 * We use Node's native https module with insecureHTTPParser: true.
 */

'use strict';

const https    = require('https');
const cheerio  = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

// ─── Config ───────────────────────────────────────────────────────────────────

const COUNTRY_CODE   = 'DE';
const SOURCE         = 'BaFin Germany';
const CURRENCY       = 'EUR';
const RETENTION_DAYS = 14;
const CONCURRENCY    = 4;   // simultaneous letter-fetches

const BASE_URL  = 'portal.mvp.bafin.de';
const CSV_PATH  = '/database/DealingsInfo/sucheForm.do?d-4000784-e=1&emittentName={LETTER}&6578706f7274=1';
const DETAIL_BASE = 'https://portal.mvp.bafin.de/database/DealingsInfo/ergebnisListe.do?cmd=loadMeldepflichtigeAction';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// ─── Ticker lookup — major German stocks ─────────────────────────────────────

const TICKER_MAP = {
  'sap se':                   'SAP',
  'siemens aktiengesellschaft': 'SIE',
  'siemens ag':               'SIE',
  'siemens energy':           'ENR',
  'volkswagen':               'VOW3',
  'bmw':                      'BMW',
  'mercedes-benz':            'MBG',
  'daimler':                  'MBG',
  'allianz':                  'ALV',
  'deutsche bank':            'DBK',
  'commerzbank':              'CBK',
  'deutsche telekom':         'DTE',
  'e.on':                     'EOAN',
  'eon se':                   'EOAN',
  'basf':                     'BAS',
  'bayer':                    'BAYN',
  'fresenius':                'FRE',
  'infineon':                 'IFX',
  'münchener rück':           'MUV2',
  'munich re':                'MUV2',
  'hannover rück':            'HNR1',
  'hannover re':              'HNR1',
  'adidas':                   'ADS',
  'puma':                     'PUM',
  'henkel':                   'HEN3',
  'rheinmetall':              'RHM',
  'heidelbergcement':         'HEI',
  'heidelberg materials':     'HEI',
  'continental':              'CON',
  'symrise':                  'SY1',
  'sartorius':                'SRT3',
  'merck kgaa':               'MRK',
  'merck kg':                 'MRK',
  'mtu aero':                 'MTX',
  'lufthansa':                'LHA',
  'vonovia':                  'VNA',
  'covestro':                 '1COV',
  'brenntag':                 'BNR',
  'beiersdorf':               'BEI',
  'qiagen':                   'QIA',
  'airbus':                   'AIR',
  'zalando':                  'ZAL',
  'delivery hero':            'DHER',
  'auto1':                    'AG1',
  'teamviewer':               'TMV',
  'dws group':                'DWS',
  'scout24':                  'G24',
  'ströer':                   'SAX',
  'amadeus fire':             'AAD',
  'all for one':              'A1OS',
  'schaeffler':               'SHA',
  'stock3':                   'ST3',
};

function getTicker(companyName) {
  if (!companyName) return null;
  const lower = companyName.toLowerCase();
  for (const [fragment, ticker] of Object.entries(TICKER_MAP)) {
    if (lower.includes(fragment)) return ticker;
  }
  // Fallback: use ISIN if available (set later), or first word
  return null;
}

// ─── Number parsing (German locale) ──────────────────────────────────────────

// "35.800,00 EUR" → 35800.00   "163,54 EUR" → 163.54
function parseGermanNumber(str) {
  if (!str || str.trim() === '') return null;
  // Strip currency suffix and whitespace
  const cleaned = str.replace(/[A-Z€\s]/g, '').trim();
  if (!cleaned) return null;
  // German: period = thousands separator, comma = decimal separator
  const normalised = cleaned.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(normalised);
  return isNaN(val) ? null : val;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

// BaFin dates: "08.04.2026" (DD.MM.YYYY)
function parseBafinDate(str) {
  if (!str || str.trim() === '') return null;
  const [day, month, year] = str.trim().split('.');
  if (!day || !month || !year) return null;
  const d = new Date(`${year}-${month}-${day}`);
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cutoff() {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d;
}

// ─── Transaction type mapping ─────────────────────────────────────────────────

function mapTransactionType(art) {
  if (!art) return 'UNKNOWN';
  const lower = art.toLowerCase();
  if (lower === 'kauf')     return 'BUY';
  if (lower === 'verkauf')  return 'SELL';
  return 'OTHER';
}

// ─── Filing ID ────────────────────────────────────────────────────────────────

function makeFilingId(bafinId, txDate, insiderName, notifDate) {
  // Combine stable fields. insiderName: first 12 alphanum chars
  const slug = (insiderName || '').replace(/\W/g, '').slice(0, 12).toLowerCase();
  return `BAFIN-${bafinId}-${txDate}-${notifDate}-${slug}`;
}

// ─── HTTP fetch via native https (insecureHTTPParser avoids BaFin header bugs) ─

function fetchUrl(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path,
      method: 'GET',
      insecureHTTPParser: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────

function parseCsv(csvText, letter) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];

  // Skip BOM if present
  const header = lines[0].replace(/^\uFEFF/, '').split(';');

  // Expected columns (0-indexed):
  // 0  Emittent
  // 1  BaFin-ID
  // 2  ISIN
  // 3  Meldepflichtiger
  // 4  Position / Status
  // 5  Art des Instruments
  // 6  Art des Geschäfts
  // 7  Durchschnittspreis
  // 8  Aggregiertes Volumen
  // 9  Mitteilungsdatum
  // 10 Datum des Geschäfts
  // 11 Ort des Geschäfts
  // 12 Datum der Aktivierung

  const cutoffDate = cutoff();
  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 11) continue;

    const company     = cols[0].trim();
    const bafinId     = cols[1].trim();
    const isin        = cols[2].trim();
    const insider     = cols[3].trim();
    const role        = cols[4].trim();
    const artGeschäft = cols[6].trim();
    const priceStr    = cols[7].trim();
    const volumeStr   = cols[8].trim();
    const notifDate   = cols[9].trim();
    const txDateStr   = cols[10].trim();

    const txDate = parseBafinDate(txDateStr);
    if (!txDate || txDate < cutoffDate) continue;

    const txDateIso = toDateStr(txDate);

    // Parse notif date (strip time if present)
    const notifDateShort = notifDate.split(' ')[0].replace(/\./g, '');

    const price  = parseGermanNumber(priceStr);
    const volume = parseGermanNumber(volumeStr);
    let shares = null;
    if (price && price > 0 && volume) {
      shares = Math.round(volume / price);
    }

    const txType = mapTransactionType(artGeschäft);

    // filing_url: link to company detail on BaFin portal
    const filingUrl = `https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do?emittentName=${encodeURIComponent(letter)}`;

    entries.push({
      filing_id:        makeFilingId(bafinId, txDateIso, insider, notifDateShort),
      country_code:     COUNTRY_CODE,
      ticker:           getTicker(company) || (isin ? isin.slice(2, 6) : null) || company.split(/[\s,]/)[0].toUpperCase().slice(0, 6),
      company,
      isin:             isin || null,
      insider_name:     insider || null,
      insider_role:     role   || null,
      transaction_type: txType,
      transaction_date: txDateIso,
      shares,
      price_per_share:  price,
      total_value:      volume !== null ? Math.round(volume) : null,
      currency:         CURRENCY,
      filing_url:       filingUrl,
      source:           SOURCE,
    });
  }

  return entries;
}

// ─── Fetch one letter with retry ─────────────────────────────────────────────

async function fetchLetter(letter, attempt = 1) {
  const path = CSV_PATH.replace('{LETTER}', encodeURIComponent(letter));
  try {
    const { status, body } = await fetchUrl(path);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return parseCsv(body, letter);
  } catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return fetchLetter(letter, attempt + 1);
    }
    console.warn(`  ⚠  Letter ${letter} failed after ${attempt} attempts: ${err.message}`);
    return [];
  }
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: limit }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeDE() {
  console.log('🇩🇪  BaFin Germany — MAR Article 19 insider notifications (CSV export)');
  const t0 = Date.now();

  console.log(`  Fetching CSV exports for letters A–Z (concurrency=${CONCURRENCY})…`);
  const letterResults = await runWithConcurrency(LETTERS, fetchLetter, CONCURRENCY);

  // Flatten and deduplicate by filing_id
  const seen = new Set();
  const allEntries = [];
  for (const batch of letterResults) {
    for (const e of batch) {
      if (!seen.has(e.filing_id)) {
        seen.add(e.filing_id);
        allEntries.push(e);
      }
    }
  }

  console.log(`  ${allEntries.length} entries in last ${RETENTION_DAYS} days across all letters`);

  if (allEntries.length === 0) {
    console.log('  No entries found.');
    return { saved: 0 };
  }

  // Remove isin field (not in DB schema — only used for ticker fallback above)
  const rows = allEntries.map(({ isin, ...rest }) => rest);

  console.log(`  Upserting ${rows.length} rows into Supabase…`);
  const { inserted, error } = await saveInsiderTransactions(rows);

  if (error) {
    console.error('  ❌ Supabase error:', error.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sample = allEntries.slice(0, 3).map(e =>
    `${e.company} / ${e.insider_name} / ${e.transaction_type} @ ${e.price_per_share ? `${e.price_per_share} EUR` : 'n/a'}`
  ).join('\n    ');

  console.log(`  ✅ Done in ${elapsed}s — ${rows.length} rows saved`);
  console.log(`  Sample:\n    ${sample}`);

  // Log type breakdown
  const buys  = allEntries.filter(e => e.transaction_type === 'BUY').length;
  const sells = allEntries.filter(e => e.transaction_type === 'SELL').length;
  const other = allEntries.filter(e => e.transaction_type === 'OTHER').length;
  console.log(`  Types: ${buys} BUY, ${sells} SELL, ${other} OTHER`);

  return { saved: rows.length };
}

scrapeDE().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
