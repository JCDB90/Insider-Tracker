/**
 * Netherlands (NL) — Insider Transactions Scraper
 *
 * Source: AFM (Autoriteit Financiële Markten) — MAR Article 19 Register
 * Export: https://www.afm.nl/export.aspx?type=0ee836dc-5520-459d-bcf4-a4a689de6614&format=xml
 *
 * Available fields from XML export:
 *   ✅ meldingid, transactiedatum, uitgevendeinstelling (company),
 *      meldingsplichtige (insider name), functie (role), lei
 *
 * Not in XML (detail pages require JavaScript rendering):
 *   ❌ transaction_type (BUY/SELL), shares, price_per_share
 *
 * Note: AFM only records that a notification was filed. The actual transaction
 * direction and size are on the individual MAR19 notification PDFs/detail pages
 * which require a browser session. These fields are saved as null for now.
 */

'use strict';

const fetch  = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

// ─── Config ───────────────────────────────────────────────────────────────────

const COUNTRY_CODE   = 'NL';
const SOURCE         = 'AFM Netherlands';
const CURRENCY       = 'EUR';
const RETENTION_DAYS = 14;

const EXPORT_URL =
  'https://www.afm.nl/export.aspx?type=0ee836dc-5520-459d-bcf4-a4a689de6614&format=xml';

const REGISTER_URL =
  'https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/transacties-leidinggevonden-mar19-';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── Ticker lookup — Euronext Amsterdam (top stocks) ─────────────────────────

const TICKER_MAP = {
  'asml':               'ASML',
  'shell':              'SHELL',
  'unilever':           'UNA',
  'ing groep':          'INGA',
  'ing bank':           'INGA',
  'heineken':           'HEIA',
  'philips':            'PHIA',
  'nn group':           'NN',
  'randstad':           'RAND',
  'wolters kluwer':     'WKL',
  'aegon':              'AGN',
  'abn amro':           'ABN',
  'adyen':              'ADYEN',
  'imcd':               'IMCD',
  'flow traders':       'FLOW',
  'signify':            'LIGHT',
  'oci ':               'OCI',
  'sbm offshore':       'SBMO',
  'asr nederland':      'ASRNL',
  'aalberts':           'AALB',
  'corbion':            'CRBN',
  'arcadis':            'ARCAD',
  'fugro':              'FUR',
  'postnl':             'PNL',
  'besi':               'BESI',
  'boskalis':           'BOKA',
  'just eat':           'TKWY',
  'jde peet':           'JDEP',
  'akzonobel':          'AKZA',
  'akzo nobel':         'AKZA',
  'airbus':             'AIR',
  'arcelormittal':      'MT',
  'euronext':           'ENX',
  'basic-fit':          'BFIT',
  'asm international':  'ASM',
  'prosus':             'PRX',
  'relx':               'REN',
  'ab inbev':           'ABI',
  'onward medical':     'ONWD',
};

function getTicker(companyName) {
  if (!companyName) return null;
  const lower = companyName.toLowerCase();
  for (const [fragment, ticker] of Object.entries(TICKER_MAP)) {
    if (lower.includes(fragment)) return ticker;
  }
  // Fallback: first word uppercased, max 6 chars
  return companyName.split(/[\s,.]/)[0].toUpperCase().slice(0, 6) || null;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

// AFM dates: "4/2/2026 12:00:00 AM" (M/D/YYYY — US locale from IIS)
// V8's Date constructor handles this format natively.
function parseAfmDate(str) {
  if (!str) return null;
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(d) {
  // Returns "YYYY-MM-DD" in local time
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

// ─── XML export ───────────────────────────────────────────────────────────────

async function fetchExport() {
  console.log('  Downloading AFM XML export…');
  const res = await fetch(EXPORT_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching export`);
  const xml = await res.text();
  console.log(`  Export: ${(xml.length / 1024).toFixed(0)} KB received`);
  return xml;
}

function parseExport(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const cutoffDate = cutoff();
  const entries = [];
  let skipped = 0;

  $('vermelding').each((_, el) => {
    const datum = $(el).find('transactiedatum').text().trim();
    const date  = parseAfmDate(datum);

    if (!date || date < cutoffDate) { skipped++; return; }

    entries.push({
      meldingid:   $(el).find('meldingid').text().trim(),
      date:        toDateStr(date),
      company:     $(el).find('uitgevendeinstelling').text().trim(),
      insiderName: $(el).find('meldingsplichtige').text().trim(),
      role:        $(el).find('functie').text().trim(),
      lei:         $(el).find('lei').text().trim(),
    });
  });

  console.log(`  ${entries.length} entries in last ${RETENTION_DAYS} days (${skipped} older, skipped)`);
  return entries;
}

// ─── Build Supabase row ───────────────────────────────────────────────────────

function buildRow(e) {
  return {
    filing_id:        e.meldingid,
    country_code:     COUNTRY_CODE,
    ticker:           getTicker(e.company),
    company:          e.company,
    insider_name:     e.insiderName || null,
    insider_role:     translateRole(e.role) || null,
    transaction_type: 'UNKNOWN',     // AFM XML doesn't include direction; detail pages require JS
    transaction_date: e.date,
    shares:           null,          // Not in XML
    price_per_share:  null,          // Not in XML
    total_value:      null,          // Not in XML
    currency:         CURRENCY,
    filing_url:       `${REGISTER_URL}?id=${encodeURIComponent(e.meldingid)}`,
    source:           SOURCE,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeNL() {
  console.log('🇳🇱  AFM Netherlands — MAR Article 19 insider notifications');
  const t0 = Date.now();

  const xml     = await fetchExport();
  const entries = parseExport(xml);

  if (entries.length === 0) {
    console.log('  No entries in the last 90 days.');
    return { saved: 0 };
  }

  const rows = entries.map(buildRow);

  console.log(`  Upserting ${rows.length} rows into Supabase…`);
  const { inserted, error } = await saveInsiderTransactions(rows);

  if (error) {
    console.error('  ❌ Supabase error:', error.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sample  = entries.slice(0, 3).map(e => `${e.company} / ${e.insiderName}`).join(', ');

  console.log(`  ✅ Done in ${elapsed}s — ${rows.length} rows saved`);
  console.log(`  Sample: ${sample}…`);
  console.log(`  ⚠  transaction_type/shares/price: null (AFM XML doesn't include these)`);

  return { saved: rows.length };
}

scrapeNL().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
