/**
 * Spain (ES) — Insider Transactions Scraper
 *
 * Source: CNMV (Comisión Nacional del Mercado de Valores)
 *
 * ── Why /Portal/Consultas/ not /Portal/MAR/ ──────────────────────────────────
 * The main MAR portal at /Portal/MAR/Operaciones-Directivos is geo-blocked by
 * CNMV's CVFE WAF for non-EU IPs. The Consultas portal is NOT geo-blocked and
 * contains the same MAR Art. 19 filings with full document links.
 *
 * ── Data flow ─────────────────────────────────────────────────────────────────
 * 1. GET Directivos-Resultado.aspx?fechad=DD/MM/YYYY&fechah=DD/MM/YYYY&page=N
 *    HTML list: date, company (NIF), insider name, role, registration number,
 *    PDF document URL (webservices/verdocumento/ver?e=TOKEN)
 * 2. For each filing: fetch PDF via pdf-parse, extract text.
 *    Parsed fields: ISIN, transaction type (Adquisición/Transmisión),
 *    price, shares, currency.
 * 3. Upsert to Supabase on filing_id = ES-{registrationNumber}.
 *
 * ── PDF format ────────────────────────────────────────────────────────────────
 * CNMV PDFs follow the ESMA standard notification form (Annex II, Regulation
 * EU 2016/523). Key text patterns:
 *   - ISIN: "Código de identificación del instrumento financiero: ES..."
 *   - TX type: "Naturaleza de la transacción: Adquisición / Transmisión..."
 *   - Price/shares: "Precio [N] Volumen [N]" or aggregate "Volumen total [N]"
 */

'use strict';

const https   = require('https');
const cheerio = require('cheerio');
const { PDFParse } = require('pdf-parse');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'ES';
const SOURCE         = 'CNMV Spain';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';

// Concurrent PDF fetches and delay between batches (be polite to CNMV)
const PDF_CONCURRENCY = 4;
const PDF_DELAY_MS    = 400;

// ─── Ticker lookup — IBEX 35 + main mid-caps ──────────────────────────────────

const TICKER_MAP = {
  'inditex':              'ITX',
  'santander':            'SAN',
  'banco santander':      'SAN',
  'bbva':                 'BBVA',
  'bilbao vizcaya':       'BBVA',
  'telefonica':           'TEF',
  'iberdrola':            'IBE',
  'repsol':               'REP',
  'caixabank':            'CABK',
  'naturgy':              'NTGY',
  'gas natural':          'NTGY',
  'endesa':               'ELE',
  'ferrovial':            'FER',
  'cellnex':              'CLNX',
  'amadeus':              'AMS',
  'acerinox':             'ACX',
  'arcelormittal':        'MTS',
  'mapfre':               'MAP',
  'iberia':               'IAG',
  'fluidra':              'FDR',
  'inmobiliaria colonial':'COL',
  'solaria':              'SLR',
  'grifols':              'GRF',
  'acciona energia':      'ANE',
  'acciona energias':     'ANE',
  'acciona':              'ANA',
  'aena':                 'AENA',
  'indra':                'IDR',
  'prosegur cash':        'CASH',
  'prosegur':             'PSG',
  'melia':                'MEL',
  'bankinter':            'BKT',
  'sabadell':             'SAB',
  'banco sabadell':       'SAB',
  'unicaja':              'UNI',
  'almirall':             'ALM',
  'ence':                 'ENC',
  'viscofan':             'VIS',
  'logista':              'LOG',
  'rovi':                 'ROVI',
  'pharma mar':           'PHM',
  'talgo':                'TLGO',
  'enagas':               'ENG',
  'redeia':               'REE',
  'red electrica':        'REE',
  'sacyr':                'SCYR',
  'tecnicas reunidas':    'TRE',
  'vidrala':              'VID',
  'ebro foods':           'EBRO',
  'merlin properties':    'MRL',
  'merlin':               'MRL',
  'lar espana':           'LARE',
  'grenergy':             'GRE',
  'acs':                  'ACS',
  'obrascon':             'OHL',
  'ohl':                  'OHL',
  'bankia':               'BKIA',
  'neinor':               'HOME',
  'colonial':             'COL',
};

function getTicker(company) {
  if (!company) return null;
  // Normalize: lowercase, strip accents
  const lower = company.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [frag, ticker] of Object.entries(TICKER_MAP)) {
    const normFrag = frag.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (lower.includes(normFrag)) return ticker;
  }
  return company.split(/[\s,.(]/)[0].toUpperCase().slice(0, 6) || null;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toCnmvDate(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
// "20/04/2026" → "2026-04-20"
function cnmvToIso(s) {
  if (!s) return null;
  const [dd, mm, yyyy] = s.trim().split('/');
  if (!yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(hostname, path) {
  return new Promise(resolve => {
    const req = https.get({
      hostname,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body:   Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Results-page HTML parser ─────────────────────────────────────────────────

function parseResultsPage(html) {
  const $ = cheerio.load(html);
  const entries = [];

  // Each filing: <li><ul> with 5 <li> children:
  // [0] date  [1] company+NIF link  [2] "Declarante: NAME"
  // [3] role + doc URL  [4] "Número de registro: N"
  $('li ul').each((_, ul) => {
    const lis = $(ul).find('> li');
    if (lis.length < 4) return;

    const dateTxt     = $(lis[0]).text().trim();
    const companyEl   = $(lis[1]).find('a').first();
    const company     = companyEl.text().trim();
    const nifHref     = companyEl.attr('href') || '';
    const nif         = (nifHref.match(/nif=([^&]+)/i) || [])[1] || null;

    const insiderTxt  = $(lis[2]).text().trim();
    const insiderName = insiderTxt.replace(/^Declarante:\s*/i, '').trim();

    const docEl       = $(lis[3]).find('a').first();
    const docUrl      = docEl.attr('href') || null;
    const roleRaw     = docEl.text().trim();
    const role        = roleRaw.replace(/^Motivo de la notificaci[oó]n:\s*/i, '').trim();

    const regTxt      = $(lis[4]).text().trim();
    const regNum      = (regTxt.match(/(\d+)/) || [])[1] || null;

    const txDate = cnmvToIso(dateTxt);
    if (!txDate || !company || !insiderName || !regNum) return;

    entries.push({ txDate, company, nif, insiderName, role, docUrl, regNum });
  });

  return entries;
}

function hasNextPage(html, currentPage) {
  // Check if next page link exists
  return html.includes(`page=${currentPage + 1}`) ||
         (html.match(/page=(\d+)/g) || []).some(m => parseInt(m.split('=')[1]) > currentPage);
}

// ─── Paginate through all results ─────────────────────────────────────────────

async function fetchAllFilings(fechad, fechah) {
  const all = [];
  let page = 1;

  while (page <= 300) {
    const path = `/portal/Consultas/Directivos-Resultado?fechad=${fechad}&fechah=${fechah}&page=${page}`;
    const res = await httpGet('www.cnmv.es', path);

    if (!res || res.status !== 200) {
      if (page === 1) console.log(`  ⚠  Results page: HTTP ${res?.status ?? 'error'}`);
      break;
    }

    const entries = parseResultsPage(res.body);
    if (entries.length === 0) break;

    all.push(...entries);

    if (!hasNextPage(res.body, page)) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
  }

  return all;
}

// ─── PDF text extraction + parsing ───────────────────────────────────────────

// Parse Spanish/European number format: "1.234,56" → 1234.56, "15,45" → 15.45
function parseEsNum(s) {
  if (!s) return null;
  const str = s.trim().replace(/\s/g, '');
  if (!str || str === '-') return null;
  if (/\d\.\d{3},/.test(str)) {
    // Spanish thousands-dot, decimal-comma: 1.234,56
    return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  }
  if (/\d,\d{3}\./.test(str)) {
    // English thousands-comma, decimal-dot: 1,234.56
    return parseFloat(str.replace(/,/g, ''));
  }
  if (/^\d[\d.]*,\d{1,4}$/.test(str)) {
    // Decimal comma only: "15,45" or "1.234,5"
    return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(str.replace(/,/g, '')) || null;
}

function parsePdfText(text) {
  if (!text || text.length < 50) return {};

  // ── Transaction type ──────────────────────────────────────────────────────
  // CNMV PDFs use ESMA standard column 4.c "Naturaleza de la operación":
  //   Adquisición / Otros → BUY
  //   Transmisión y disposición / Disposición / Enajenación → SELL
  // Check SELL first (more specific vocabulary).
  let txType = null;
  if (/transmisi[oó]n\s+y\s+disposici[oó]n|disposici[oó]n|transmisi[oó]n|enajenaci[oó]n|\bventa\b|\bdisposal\b|\bsale\b/i.test(text)) {
    txType = 'SELL';
  } else if (/adquisici[oó]n|\bcompra\b|\botros\b|ejercicio\s+de\s+opci[oó]n|\bvesting\b|\baward\b/i.test(text)) {
    txType = 'BUY';
  }

  // ── ISIN, price, volume: from ISIN-anchored data row ─────────────────────
  // CNMV PDFs: data row format is:
  //   ISIN  instrument_type  tx_type  DD/MM/YYYY  venue  volume  unit_price  currency
  // e.g.: ES0105229001 Acción Otros 09/04/2026 XOFF 115513,00 0,63 EUR
  let isin = null, shares = null, price = null, currency = CURRENCY;

  // Primary: ISIN-anchored row pattern (handles 1–4 words between ISIN and date)
  const rowMatch = text.match(
    /([A-Z]{2}[A-Z0-9]{10})\s+\S+(?:\s+\S+){1,4}\s+\d{2}\/\d{2}\/\d{4}\s+\S+\s+([\d.,]+)\s+([\d.,]+)\s+(EUR|USD|GBP|CHF|SEK|DKK|NOK)\b/
  );
  if (rowMatch) {
    isin     = rowMatch[1];
    shares   = Math.round(parseEsNum(rowMatch[2]) || 0) || null;
    price    = parseEsNum(rowMatch[3]);
    currency = rowMatch[4];
  }

  // Fallback ISIN: look near "Código de identificación" label
  if (!isin) {
    const codeMatch = text.match(/[Cc][oó]digo\s+de[^\n]{0,60}\n+\s*([A-Z]{2}[A-Z0-9]{10})\b/);
    if (codeMatch) isin = codeMatch[1];
  }

  // Fallback: "Total Agregado / Aggregated information" section
  // Format after heading: volume  unit_price  (two numbers on one line)
  if (!shares || price == null) {
    const aggIdx = text.search(/total\s+agregado|aggregated\s+information/i);
    if (aggIdx >= 0) {
      const afterAgg = text.slice(aggIdx, aggIdx + 300);
      // Filter out single-digit section numbers (e.g., "5)")
      const nums = (afterAgg.match(/\d[\d.,]+/g) || []).filter(n => n.length > 1 || /[.,]/.test(n));
      if (nums.length >= 1 && !shares)      shares = Math.round(parseEsNum(nums[0]) || 0) || null;
      if (nums.length >= 2 && price == null) price  = parseEsNum(nums[1]);
    }
  }

  // Currency (already captured from row; scan full text as last resort)
  if (currency === CURRENCY) {
    const currMatch = text.match(/\b(EUR|USD|GBP|CHF|SEK|DKK|NOK)\b/);
    if (currMatch) currency = currMatch[1];
  }

  return { txType, isin, price, shares, currency };
}

async function parsePdfFromUrl(docUrl) {
  if (!docUrl) return {};
  try {
    const parser = new PDFParse({ url: docUrl });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    return parsePdfText(result.text || '');
  } catch {
    return {};
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeES() {
  console.log('🇪🇸  CNMV Spain — MAR Art. 19 insider transactions (Consultas + PDF)');
  const t0 = Date.now();

  const co     = cutoff();
  const fechad = toCnmvDate(co);
  const fechah = toCnmvDate(new Date());
  console.log(`  Fetching ${fechad} → ${fechah}…`);

  // Step 1: collect all filing metadata from paginated HTML results
  const filings = await fetchAllFilings(fechad, fechah);
  if (filings.length === 0) {
    console.log('  No filings found in window.');
    return { saved: 0 };
  }
  console.log(`  Found ${filings.length} filings — fetching PDFs…`);

  // Step 2: fetch PDFs in parallel batches and parse transaction details
  const rows = [];
  let pdfFailed = 0;

  for (let i = 0; i < filings.length; i += PDF_CONCURRENCY) {
    const batch = filings.slice(i, i + PDF_CONCURRENCY);

    const results = await Promise.all(
      batch.map(f => parsePdfFromUrl(f.docUrl).then(pdf => ({ f, pdf })))
    );

    for (const { f, pdf } of results) {
      if (!pdf.txType) { pdfFailed++; continue; }

      const shares = pdf.shares ?? null;
      const price  = pdf.price  ?? null;

      rows.push({
        filing_id:        `ES-${f.regNum}`,
        country_code:     COUNTRY_CODE,
        source:           SOURCE,
        ticker:           getTicker(f.company),
        company:          f.company,
        insider_name:     f.insiderName,
        insider_role:     f.role || 'Not disclosed',
        transaction_type: pdf.txType,
        transaction_date: f.txDate,
        shares,
        price_per_share:  price,
        total_value:      (price != null && shares) ? Math.round(price * shares) : null,
        currency:         pdf.currency || CURRENCY,
        filing_url:       f.docUrl || `https://www.cnmv.es/Portal/Consultas/Directivos-Resultado.aspx`,
      });
    }

    if (i % 40 === 0 && i > 0) {
      console.log(`  Progress: ${i}/${filings.length} PDFs, ${rows.length} rows…`);
    }
    if (i + PDF_CONCURRENCY < filings.length) {
      await new Promise(r => setTimeout(r, PDF_DELAY_MS));
    }
  }

  const parseRate = filings.length > 0
    ? ((rows.length / filings.length) * 100).toFixed(0)
    : 0;
  console.log(`  Parsed ${rows.length}/${filings.length} filings (${parseRate}% success, ${pdfFailed} skipped)`);

  if (rows.length === 0) {
    console.log('  No BUY/SELL transactions extracted from PDFs.');
    return { saved: 0 };
  }

  for (const r of rows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares ?? '?'} @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(rows);
  if (error) {
    console.error('  ❌ Supabase:', error.message);
    process.exit(1);
  }

  const buys    = rows.filter(r => r.transaction_type === 'BUY').length;
  const sells   = rows.filter(r => r.transaction_type === 'SELL').length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${rows.length} rows saved (${buys} BUY, ${sells} SELL)`);
  return { saved: rows.length };
}

scrapeES().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
