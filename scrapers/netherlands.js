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
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');

// AFM bestuurders-commissarissen register type ID (found in the export URL on the AFM register page)
const REGISTER_TYPE = '1b934036-12ad-4950-9773-31361d5adbd9';

// Ordinary share security types that determine BUY/SELL direction.
// "Gewoon aandeel" is the main type; also match English names for dual-listed companies.
const ORDINARY_SHARE_TYPES = /gewoon\s+aandeel|ordinary\s+share|common\s+share|aandeel op naam/i;

// Conditional/restricted/performance share types — vestings and exercises of these
// are also reportable insider transactions.  Price is typically 0 (free grant).
const CONDITIONAL_SHARE_TYPES = /conditional\s+share|restricted\s+share|performance\s+share|rsu|ltip|voorwaardelijk|aandelen(?:recht|toekenning)|phantom|depositary/i;

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
  // Extended — companies registered in NL but sometimes on other exchanges
  'magnum ice cream':   'MICC',
  'campari':            'CPR',
  'oci n.v':            'OCI',
  'argenx':             'ARGX',
  'nepi rockcastle':    'NRP',
  'cementir':           'CEM',
  'ctp n.v':            'CTPNV',
  'unibail':            'URW',
  'universal music':    'UMG',
  'ahold delhaize':     'AD',
  'bam groep':          'BAMNB',
  'photon energy':      'PEN',
  'tomtom':             'TOM2',
  'ferrari n.v':        'RACE',
  'ad pepper':          'ADP',
  'brunel':             'BRNL',
  'alfen':              'ALFEN',
  'new sources energy': 'NSE',
  'vivoryon':           'VVY',
  'kendrion':           'KENDR',
  'ease2pay':           'EAS2P',
  'amg critical':       'AMG',
  'qiagen':             'QGEN',
  'ebusco':             'EBUS',
  'envipco':            'ENVI',
};

function getTicker(companyName) {
  if (!companyName) return null;
  const lower = companyName.toLowerCase();
  for (const [fragment, ticker] of Object.entries(TICKER_MAP)) {
    if (lower.includes(fragment)) return ticker;
  }
  return null;
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

    // A single AFM filing can contain multiple Wijzigingen that represent distinct transactions,
    // e.g. a performance-award vesting (price=0) followed by a same-day cash sell (price>0).
    // Netting them together produces wrong results; we split by price category instead.

    const ordinaryChanges    = changes.filter(c => ORDINARY_SHARE_TYPES.test(c.soort));
    const conditionalChanges = changes.filter(c => !ORDINARY_SHARE_TYPES.test(c.soort) && CONDITIONAL_SHARE_TYPES.test(c.soort));

    // Ordinary shares at market price (actual cash transactions)
    const cashSells   = ordinaryChanges.filter(c => c.prijs > 0 && c.aantal < 0);
    const cashBuys    = ordinaryChanges.filter(c => c.prijs > 0 && c.aantal > 0);
    // Ordinary shares received for free (vestings / grants)
    const freeGains   = ordinaryChanges.filter(c => c.prijs === 0 && c.aantal > 0);

    const sumCashSell  = cashSells.reduce((s, c) => s + Math.abs(c.aantal), 0);
    const sumCashBuy   = cashBuys.reduce((s, c) => s + c.aantal, 0);
    const sumFreeGain  = freeGains.reduce((s, c) => s + c.aantal, 0);
    const netCond      = conditionalChanges.reduce((s, c) => s + c.aantal, 0);

    // Build the base row template
    const base = {
      country_code:     COUNTRY_CODE,
      source:           SOURCE,
      ticker:           getTicker(company) || '',
      company:          company || null,
      insider_name:     insiderName || null,
      insider_role:     'Director / Commissioner',
      transaction_date: txDate,
      filing_url:       `https://www.afm.nl/nl-nl/sector/registers/meldingenregisters/bestuurders-commissarissen/details?id=${id}`,
    };

    let pushed = 0;

    // ── Cash SELL (primary row — most significant for market-abuse monitoring) ──
    if (sumCashSell > 0) {
      const pe = cashSells[0];
      rows.push({ ...base, filing_id: `NL-${id}`, transaction_type: 'SELL',
        shares: sumCashSell, price_per_share: pe.prijs, currency: pe.valuta,
        total_value: Math.round(pe.prijs * sumCashSell) });
      pushed++;
    }

    // ── Cash BUY (direct market purchase or option exercise without same-day sell) ──
    if (sumCashBuy > 0 && sumCashSell === 0) {
      const pe = cashBuys[0];
      rows.push({ ...base, filing_id: `NL-${id}`, transaction_type: 'BUY',
        shares: sumCashBuy, price_per_share: pe.prijs, currency: pe.valuta,
        total_value: Math.round(pe.prijs * sumCashBuy) });
      pushed++;
    }

    // ── RSU/grant vestings: ordinary shares received at price=0 ─────────────
    // Skip entirely — free grants are not real market buy decisions.
    if (pushed === 0 && sumFreeGain > 0) skipped++;

    // ── Fallback: conditional/restricted/performance instruments only ───────────
    if (pushed === 0 && netCond !== 0) {
      const txType = netCond > 0 ? 'BUY' : 'SELL';
      const shares = Math.abs(netCond);
      const pe = conditionalChanges.find(c => c.prijs > 0) || conditionalChanges[0];
      const price  = pe?.prijs  ?? 0;
      if (price === 0) { skipped++; continue; }  // skip price-less vestings
      const valuta = pe?.valuta ?? CURRENCY;
      const total  = Math.round(price * shares);
      rows.push({ ...base, filing_id: `NL-${id}`, transaction_type: txType,
        shares, price_per_share: price, currency: valuta, total_value: total });
      pushed++;
    }

    if (pushed === 0) skipped++;  // no reportable change
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
