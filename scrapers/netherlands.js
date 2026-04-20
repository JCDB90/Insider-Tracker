/**
 * Netherlands (NL) — Insider Transactions Scraper
 *
 * Source: AFM (Autoriteit Financiële Markten) — Bestuurders & Commissarissen Register
 * Export: https://www.afm.nl/export.aspx
 *           ?DateFrom=DD-MM-YYYY&DateTill=DD-MM-YYYY
 *           &type=1b934036-12ad-4950-9773-31361d5adbd9&format=xml
 *
 * This register (Directors & Commissioners) is the Dutch MAR Article 19 notification
 * register and contains full transaction data including BUY/SELL direction.
 *
 * XML structure per <vermelding>:
 *   meldingid            → integer ID
 *   DatumMeldingsplicht  → filing date (M/D/YYYY)
 *   UitgevendeInstelling → company name
 *   Meldingsplichtige    → insider name
 *   Wijzigingen          → list of changes (the actual transactions)
 *     Wijziging:
 *       SoortEffect      → security type (Gewoon aandeel, Conditional share award, etc.)
 *       AantalEffecten   → shares (positive = acquired, negative = disposed)
 *       WaardePerAandeel → price per share (0 for vesting/award transactions)
 *       Valuta           → currency
 *   Voorposities         → pre-transaction positions (for context)
 *   Naposities           → post-transaction positions (for context)
 *
 * Transaction type logic:
 *   Sum AantalEffecten for "Gewoon aandeel" (ordinary shares) entries only.
 *   Positive net → BUY, Negative net → SELL.
 *   Records with only conditional/restricted share changes → skip (OTHER).
 */

'use strict';

const https   = require('https');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'NL';
const SOURCE         = 'AFM Netherlands';
const CURRENCY       = 'EUR';
const RETENTION_DAYS = 90;

// AFM bestuurders-commissarissen register type ID (found in the export URL on the AFM register page)
const REGISTER_TYPE = '1b934036-12ad-4950-9773-31361d5adbd9';

// Ordinary share security types that determine BUY/SELL direction.
// "Gewoon aandeel" is the main type; also match English names for dual-listed companies.
const ORDINARY_SHARE_TYPES = /gewoon\s+aandeel|ordinary\s+share|common\s+share|aandeel op naam/i;

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
  'sbm offshore':       'SBMO',
  'asr nederland':      'ASRNL',
  'aalberts':           'AALB',
  'corbion':            'CRBN',
  'arcadis':            'ARCAD',
  'fugro':              'FUR',
  'postnl':             'PNL',
  'besi':               'BESI',
  'boskalis':           'BOKA',
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
  'stmicroelectronics': 'STMPA',
  'kpn':                'KPN',
  'koninklijke kpn':    'KPN',
  'ferrovial':          'FER',
  'digi communications':'DIGI',
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

function cutoff() {
  const d = new Date();
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d;
}

// AFM export date format: "M/D/YYYY" (US locale from IIS)
function parseAfmDate(str) {
  if (!str) return null;
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// AFM URL date format: "DD-MM-YYYY"
function toAfmDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${day}-${m}-${y}`;
}

// ─── XML export ───────────────────────────────────────────────────────────────

function fetchExport(dateFrom, dateTill) {
  return new Promise((resolve, reject) => {
    const qs = `DateFrom=${dateFrom}&DateTill=${dateTill}&type=${REGISTER_TYPE}&format=xml`;
    const req = https.get({
      hostname: 'www.afm.nl',
      path: `/export.aspx?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/xml, text/xml, */*',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Extract text value of a single XML tag from a record string.
 */
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

/**
 * Parse the XML export and return rows ready for Supabase.
 */
function parseXml(xml, cutoffDate) {
  const records = xml.match(/<vermelding>[\s\S]*?<\/vermelding>/g) || [];
  const rows = [];
  let skipped = 0;

  for (const r of records) {
    const id = getTag(r, 'meldingid');
    const dateRaw = getTag(r, 'DatumMeldingsplicht');
    const company = getTag(r, 'UitgevendeInstelling');
    const insiderRaw = getTag(r, 'Meldingsplichtige');
    const insiderName = insiderRaw ? insiderRaw.replace(/\s+/g, ' ').trim() : null;

    const date = parseAfmDate(dateRaw);
    if (!date || date < cutoffDate) { skipped++; continue; }
    const txDate = toIsoDate(date);

    // Parse Wijzigingen (changes)
    const wijzText = r.match(/<Wijzigingen>([\s\S]*?)<\/Wijzigingen>/)?.[1] || '';
    const wijzEntries = wijzText.match(/<Wijziging>[\s\S]*?<\/Wijziging>/g) || [];

    const changes = wijzEntries.map(w => ({
      soort:  getTag(w, 'SoortEffect') || '',
      aantal: parseInt(getTag(w, 'AantalEffecten') || '0', 10),
      prijs:  parseFloat(getTag(w, 'WaardePerAandeel') || '0'),
      valuta: getTag(w, 'Valuta') || CURRENCY,
    }));

    // Determine BUY/SELL from ordinary shares only
    const ordinaryChanges = changes.filter(c => ORDINARY_SHARE_TYPES.test(c.soort));
    const netOrdinary = ordinaryChanges.reduce((s, c) => s + c.aantal, 0);

    let txType;
    if (netOrdinary > 0)      txType = 'BUY';
    else if (netOrdinary < 0) txType = 'SELL';
    else                      continue;  // only non-ordinary changes → skip

    const shares = Math.abs(netOrdinary);
    // Use price from the first ordinary-share change that has a non-zero price
    const priceEntry = ordinaryChanges.find(c => c.prijs > 0);
    const price  = priceEntry ? priceEntry.prijs   : null;
    const valuta = priceEntry ? priceEntry.valuta  : CURRENCY;
    const total  = (price && shares) ? Math.round(price * shares) : null;

    rows.push({
      filing_id:        `NL-${id}`,
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           getTicker(company),
      company:          company || null,
      insider_name:     insiderName || null,
      insider_role:     'Not disclosed',    // not in AFM XML export
      transaction_type: txType,
      transaction_date: txDate,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         valuta,
      filing_url:       `https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/bestuurders-commissarissen/details?id=${id}`,
    });
  }

  console.log(`  Parsed ${rows.length} BUY/SELL rows (${skipped} older records skipped)`);
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeNL() {
  console.log('🇳🇱  AFM Netherlands — Bestuurders & Commissarissen (MAR Art. 19)');
  const t0 = Date.now();

  const co      = cutoff();
  const dateFrom = toAfmDate(co);
  const dateTill = toAfmDate(new Date());
  console.log(`  Fetching ${dateFrom} → ${dateTill}…`);

  let xml;
  try {
    xml = await fetchExport(dateFrom, dateTill);
    console.log(`  Export: ${(xml.length / 1024).toFixed(0)} KB received`);
  } catch (err) {
    console.error(`  ❌ Export failed: ${err.message}`);
    return { saved: 0 };
  }

  const rows = parseXml(xml, co);
  if (rows.length === 0) {
    console.log('  No BUY/SELL ordinary share transactions in the window.');
    return { saved: 0 };
  }

  // Preview
  for (const r of rows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} shares @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(rows);
  if (error) {
    console.error('  ❌ Supabase:', error.message);
    process.exit(1);
  }

  const buys  = rows.filter(r => r.transaction_type === 'BUY').length;
  const sells = rows.filter(r => r.transaction_type === 'SELL').length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${rows.length} rows saved (${buys} BUY, ${sells} SELL)`);
  return { saved: rows.length };
}

scrapeNL().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
