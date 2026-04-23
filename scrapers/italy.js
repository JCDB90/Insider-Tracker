/**
 * Italy (IT) — Insider Transactions Scraper
 *
 * Source: eMarket STORAGE (Teleborsa SDIR) — AIOS 02 Internal Dealing
 * https://www.emarketstorage.it/it/comunicati-finanziari?titolo=internal+dealing
 *
 * This replaces the old CONSOB/Puppeteer approach which was blocked by Radware.
 * eMarketstorage is the mandated SDIR (Sistema di Diffusione delle Informazioni
 * Regolamentate) where Italian listed companies must file MAR Art. 19 disclosures.
 * The site is publicly accessible with no geo-block or bot protection.
 *
 * ── Data flow ─────────────────────────────────────────────────────────────────
 * 1. GET /it/comunicati-finanziari?titolo=internal+dealing&page=N
 *    HTML list: protocol number, date, company (issuer), title, PDF link
 *    Stop when entry dates fall before the 90-day retention cutoff.
 * 2. Construct PDF URL:
 *    https://www.emarketstorage.it/sites/default/files/comunicati/YYYY-MM/YYYYMMDD_PROTO.pdf
 * 3. Fetch PDF, parse Italian/English ESMA standard form (Reg. EU 2016/523 Annex II):
 *    - Section 1.a → insider name
 *    - Section 2.a → role (PDMR / closely associated)
 *    - Section 3.a → issuer company
 *    - Section 4.a ISIN: IT0000000000
 *    - Section 4.b → CESSIONE (SELL) / ACQUISTO (BUY)
 *    - Section 4.d → Volume aggregato: N, Prezzo: N EUR
 *    - Section 4.e → ISO transaction date
 * 4. Upsert to Supabase on filing_id = IT-{protocol}.
 *
 * ── Pagination ────────────────────────────────────────────────────────────────
 * Each page has 24 entries covering ~3-4 calendar days. For a 90-day window,
 * ~23 pages suffice (cold start). Daily runs typically need 1-2 pages.
 */

'use strict';

const https   = require('https');
const { PDFParse } = require('pdf-parse');
const { saveInsiderTransactions } = require('./lib/db');
const { looksLikeCorp }           = require('./lib/entityUtils');

const COUNTRY_CODE   = 'IT';
const SOURCE         = 'eMarket STORAGE Italy';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
const HOST           = 'www.emarketstorage.it';

// Concurrent PDF fetches and delay between batches
const PDF_CONCURRENCY = 4;
const PDF_DELAY_MS    = 400;

// ─── Ticker lookup — FTSE MIB + main mid-caps ─────────────────────────────────

const TICKER_MAP = {
  'enel':               'ENEL',
  'intesa sanpaolo':    'ISP',
  'intesa':             'ISP',
  'unicredit':          'UCG',
  'stellantis':         'STLAM',
  'eni':                'ENI',
  'stmicroelectronics': 'STMMI',
  'mediobanca':         'MB',
  'generali':           'G',
  'assicurazioni generali': 'G',
  'ferrari':            'RACE',
  'leonardo':           'LDO',
  'prysmian':           'PRY',
  'moncler':            'MONC',
  'diasorin':           'DIA',
  'recordati':          'REC',
  'inwit':              'INWIT',
  'telecom italia':     'TIT',
  'tim':                'TIT',
  'terna':              'TRN',
  'snam':               'SRG',
  'italgas':            'IG',
  'azimut':             'AZM',
  'banca mediolanum':   'BMED',
  'mediolanum':         'BMED',
  'pirelli':            'PIRC',
  'campari':            'CPR',
  'amplifon':           'AMP',
  'brunello cucinelli': 'BC',
  'banco bpm':          'BAMI',
  'bper':               'BPE',
  'poste italiane':     'PST',
  'iveco':              'IVG',
  'cnh industrial':     'CNHI',
  'cnh':                'CNHI',
  'buzzi':              'BZU',
  'saipem':             'SPM',
  'tenaris':            'TEN',
  'exor':               'EXO',
  'finecobank':         'FBK',
  'fineco':             'FBK',
  'reply':              'REY',
  'nexi':               'NEXI',
  'webuild':            'WBD',
  'mondadori':          'MN',
  'd\'amico':           'DMI',
  'danieli':            'DAN',
  'datalogic':          'DAL',
  'cattolica':          'CATT',
  'cattolica assicurazioni': 'CATT',
  'brembo':             'BRE',
  'autogrill':          'AGL',
  'atlantia':           'ATL',
  'fca':                'STLAM',
  'tinexta':            'TNXT',
  'cube labs':          'CUB',
  'ipi':                'IPI',
  'cir':                'CIR',
  'cofide':             'COF',
  'rai way':            'RWAY',
  'salcef':             'SLC',
  'erg':                'ERG',
  'falck renewables':   'FKR',
  'acea':               'ACE',
  'hera':               'HER',
  'iren':               'IRE',
  'a2a':                'A2A',
  'italiaonline':       'IOL',
  'immobiliare grande distribuzione': 'IGD',
  'igd':                'IGD',
};

function getTicker(company) {
  if (!company) return null;
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
// "20/04/2026" → "2026-04-20"
function itToIso(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
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
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Results-page HTML parser ─────────────────────────────────────────────────

// Date format: "20/04/2026 - 19:38" → date part only
function parseDateFromDisplay(s) {
  const m = (s || '').match(/(\d{2}\/\d{2}\/\d{4})/);
  return m ? itToIso(m[1]) : null;
}

// Build PDF URL from filing date (in "20/04/2026" format) and protocol number
function buildPdfUrl(displayDate, proto) {
  const m = displayDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const yearMonth = `${yyyy}-${mm}`;
  const datePrefix = `${yyyy}${mm}${dd}`;
  return `https://${HOST}/sites/default/files/comunicati/${yearMonth}/${datePrefix}_${proto}.pdf`;
}

function parseResultsPage(html, cutoffDate) {
  const entries = [];
  // Match each filing entry: data-protocollo, datetime text, company, title
  const rowRegex = /data-protocollo="(\d+)"[\s\S]*?class="datetime">([^<]+)<\/time>[\s\S]*?news-azienda[^>]+><a[^>]+>([^<]+)<\/a>[\s\S]*?news-title[^>]+><a[^>]+>([^<]+)<\/a>/g;
  let m;
  let reachedCutoff = false;

  while ((m = rowRegex.exec(html)) !== null) {
    const proto       = m[1];
    const displayDate = m[2].trim();
    const company     = m[3].trim();
    const title       = m[4].trim();
    const txDate      = parseDateFromDisplay(displayDate);

    if (!txDate) continue;
    if (txDate < toIsoDate(cutoffDate)) { reachedCutoff = true; continue; }

    const pdfUrl = buildPdfUrl(displayDate, proto);
    entries.push({ proto, displayDate, txDate, company, title, pdfUrl });
  }

  return { entries, reachedCutoff };
}

// ─── Paginate through all results ─────────────────────────────────────────────

async function fetchAllFilings(co) {
  const all = [];
  let page = 0;
  let done = false;

  while (!done && page <= 150) {
    const res = await httpGet(HOST, `/it/comunicati-finanziari?titolo=internal+dealing&page=${page}`);
    if (!res || res.status !== 200) break;

    const { entries, reachedCutoff } = parseResultsPage(res.body, co);
    all.push(...entries);

    if (reachedCutoff || entries.length === 0) done = true;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  return all;
}

// ─── PDF text parsing ─────────────────────────────────────────────────────────

function parseItNum(s) {
  if (!s) return null;
  const str = s.trim().replace(/\s/g, '');
  if (!str) return null;
  if (/\d\.\d{3},/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  if (/\d,\d{3}\./.test(str)) return parseFloat(str.replace(/,/g, ''));
  if (/^\d[\d.]*,\d{1,4}$/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  return parseFloat(str.replace(/,/g, '')) || null;
}

function parsePdfText(text) {
  if (!text || text.length < 100) return {};

  // ── Insider name (section 1.a — last substantive line before section 2) ──
  let insiderName = null;
  const sec2Idx = text.search(/\n\s*2[.\s]+(?:Motivo|Reason)/i);
  if (sec2Idx > 0) {
    const sec1 = text.slice(0, sec2Idx);
    const lines = sec1.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && !/^(?:Full name|Denominazione|For legal|For natural|Indicare|Including|Legal form|Identification|Il nome|Nome:|cognome:|Last Name:|First Name:|Codice|code)/i.test(l));
    insiderName = lines[lines.length - 1] || null;
  }
  // Fallback: extract from "Oggetto : Internal dealing [NAME]"
  if (!insiderName) {
    const subjMatch = text.match(/Oggetto\s*:\s*Internal\s+dealing\s+([^\n]+)/i);
    if (subjMatch) insiderName = subjMatch[1].replace(/^-?\s*errata\s+corrige.*/i, '').trim() || null;
  }

  // ── If Section 1 name is a legal entity, find the PDMR behind it ─────────
  // MAR forms filed by closely-associated entities still reference the PDMR.
  let viaEntity = null;
  if (insiderName && looksLikeCorp(insiderName)) {
    viaEntity = insiderName;
    insiderName = null;

    // "Oggetto: Internal dealing PERSON per conto di / tramite ENTITY"
    const objM = text.match(/Oggetto\s*:\s*Internal\s+dealing\s+([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]+?)(?:\s+(?:per\s+conto\s+di|tramite|via)\b|\s*-|\s*\n)/i);
    if (objM) {
      const c = objM[1].trim();
      if (c.length > 2 && !looksLikeCorp(c)) insiderName = c;
    }
    // ESMA Section 2a bilingual form: "Nome:\nFirst Name:\nFIRST Cognome:\nLast Name:\nLAST"
    // (First name and "Cognome:" label appear on the same line due to column layout)
    if (!insiderName) {
      const ncM = text.match(/Nome:\s*\n(?:First Name:\s*\n)?([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]+?)\s+Cognome:\s*\n(?:Last Name:\s*\n)?([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]+?)(?:\s*\n|$)/m);
      if (ncM) {
        const n = `${ncM[1].trim()} ${ncM[2].trim()}`;
        if (!looksLikeCorp(n)) insiderName = n;
      }
    }
    // ESMA Section 2a: wide-spaced layout "Nome: FIRST   Cognome: LAST"
    if (!insiderName) {
      const ncM = text.match(/Nome:\s+([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]*?)\s{2,}Cognome:\s+([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]+?)(?:\s*\n|$)/m);
      if (ncM) {
        const n = `${ncM[1].trim()} ${ncM[2].trim()}`;
        if (!looksLikeCorp(n)) insiderName = n;
      }
    }
    // "Closely associated with: PERSON" / "Strettamente legato/a a: PERSON"
    if (!insiderName) {
      const caM = text.match(/(?:closely\s+associated\s+with|strettamente\s+leg(?:ato|ata)\s+a)\s*:?\s*([A-ZÀ-Ö][a-zA-ZÀ-ÿ\s\-\.]{2,50}?)(?:\n|[,;(])/i);
      if (caM) { const c = caM[1].trim(); if (!looksLikeCorp(c)) insiderName = c; }
    }
  }

  // ── Role (section 2.a) ────────────────────────────────────────────────────
  let role = 'Not disclosed';
  const roleMatch = text.match(/Posizione\s*\/\s*Qualifica\s*\n[^\n]*\n([^\n]+)/i);
  if (roleMatch) {
    const r = roleMatch[1].trim();
    role = r.includes('Strettamente') || r.includes('Closely')
      ? 'Closely Associated Person'
      : r.includes('funzioni') || r.includes('managerial')
      ? 'Person Discharging Managerial Responsibilities'
      : r;
  }

  // ── Company (section 3.a issuer) ──────────────────────────────────────────
  let company = null;
  // Bilingual form: "Nome completo dell'entità:" label
  const coMatch = text.match(/Nome\s+completo\s+dell.entit[aà]:[^\n]*\n[^\n]*\n([^\n]+)/i);
  if (coMatch) company = coMatch[1].trim();
  // Italian-only form: company name precedes the LEI code line
  if (!company) {
    const leiCoMatch = text.match(/Nome\s*4?\s*\nName\s*\n([^\n]+)\n[\s\S]{0,80}LEI/i);
    if (leiCoMatch) company = leiCoMatch[1].trim();
  }

  // ── ISIN ──────────────────────────────────────────────────────────────────
  let isin = (text.match(/ISIN:\s*([A-Z]{2}[A-Z0-9]{10})/i) || [])[1] || null;
  // Italian-only form: ISIN appears on its own line without "ISIN:" prefix
  if (!isin) {
    const standaloneIsin = text.match(/\n([A-Z]{2}[A-Z0-9]{10})\n/);
    if (standaloneIsin) isin = standaloneIsin[1];
  }

  // ── Transaction type (section 4.b) ────────────────────────────────────────
  // Two form layouts exist:
  // 1. Bilingual ESMA form: actual value on line immediately after English instruction ends
  //    ("Regulation (EU) No 596/2014.\nCESSIONE" or "...ACQUISTO")
  // 2. Italian-only form: free-text description after "Nature of the transaction\n"
  //    ("Vendita di azioni ordinarie..." / "Acquisto di azioni ordinarie...")
  // DO NOT scan the whole document — boilerplate contains "acquisto, vendita" in
  // footnote 9 instruction text on every form, causing false SELL detection.
  let txType = null;

  // Method 1: bilingual form — value after English instruction end
  const txValMatch = text.match(/Regulation\s*\(EU\)\s*No\s*596\/2014\.\s*\n([^\n]+)\n/i);
  if (txValMatch) {
    const val = txValMatch[1].trim();
    if (/\bCESSIONE\b|\bVENDITA\b|\bDisposizione\b|\bDisposal\b|\bSale\b/i.test(val)) txType = 'SELL';
    else if (/\bACQUISTO\b|\bSOTTOSCRIZIONE\b|\bAcquisition\b|\bSubscription\b|\bALTRO\b|\bOther\b|\bASSEGNAZIONE\b|\bEsercizio\b|\bGrant\b|\bVesting\b/i.test(val)) txType = 'BUY';
  }

  // Method 2: Italian-only form — description directly after "Nature of the transaction"
  if (!txType) {
    const natMatch = text.match(/Nature of the transaction\s*\n([^\n]+)/i);
    if (natMatch) {
      const val = natMatch[1].trim();
      if (!/^Descrizione/i.test(val)) { // skip if it's the bilingual instruction preamble
        if (/[Vv]endita|[Cc]essione|[Dd]isposizione/i.test(val)) txType = 'SELL';
        else if (/[Aa]cquisto|[Ss]ottoscrizione|[Aa]ssegnazione|[Ee]sercizio/i.test(val)) txType = 'BUY';
      }
    }
  }

  // ── Volume aggregato (section 4.d) ────────────────────────────────────────
  let shares = null;
  // Standard bilingual form: "Volume aggregato: N"
  const volMatch = text.match(/Volume\s+aggregato:\s*([\d.,]+)/i);
  if (volMatch) shares = Math.round(parseItNum(volMatch[1]) || 0) || null;

  // ── Weighted average price (section 4.d) ─────────────────────────────────
  let price = null, currency = CURRENCY;
  // Standard bilingual form: "Prezzo: N EUR"
  const priceMatch = text.match(/Prezzo:\s*([\d.,]+)\s+(EUR|USD|GBP|CHF|SEK|DKK|NOK)/i);
  if (priceMatch) { price = parseItNum(priceMatch[1]); currency = priceMatch[2]; }

  // Italian-only form: aggregate in "PREZZO  VOLUME\nN\tN" after "Aggregated information"
  // The section 4.d block shows: PREZZO  VOLUME\n10,3239\t10222
  if (!shares || price == null) {
    const itAggMatch = text.match(/Aggregated\s+information[\s\S]{0,300}PREZZO\s+VOLUME\s*\n([\d.,]+)\s+([\d.,]+)/i);
    if (itAggMatch) {
      if (price == null) price  = parseItNum(itAggMatch[1]);
      if (!shares)       shares = Math.round(parseItNum(itAggMatch[2]) || 0) || null;
      // Italian exchange is always EUR — no currency shown in this form layout
    }
  }

  // Fallback: parse from individual transaction row "PRICE CURRENCY VOLUME"
  if (!shares || price == null) {
    const rowMatch = text.match(/([\d.,]+)\s+(EUR|USD|GBP|CHF)\s+(\d[\d.,]*)/);
    if (rowMatch) {
      if (price == null)  price  = parseItNum(rowMatch[1]);
      if (currency === CURRENCY) currency = rowMatch[2];
      if (!shares)        shares = Math.round(parseItNum(rowMatch[3]) || 0) || null;
    }
  }

  // Skip price=0 rows (free vestings, pledge releases, etc.) — no cash transaction
  if (price === 0) return { _skipped: 'zero_price' };

  // Skip bond instruments: only reliable signal is percentage-priced "Prezzo: N %"
  if (price == null && /Prezzo:\s*[\d.,]+\s*%/i.test(text)) return { _skipped: 'debt' };

  // ── Transaction date (section 4.e) ────────────────────────────────────────
  let txDate = null;
  // Broaden search anchor to handle Italian form "Data dell' operazione" (space after apostrophe)
  const sec4eIdx = text.search(/4[.\s]*e\)|Data\s+dell.\s*operazione/i);
  if (sec4eIdx >= 0) {
    const chunk = text.slice(sec4eIdx, sec4eIdx + 400);
    // ISO format: YYYY-MM-DD
    const isoM = chunk.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoM) txDate = isoM[1];
    // Italian form format: DD/MM/YYYY
    if (!txDate) {
      const itM = chunk.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (itM) txDate = itToIso(itM[1]);
    }
  }
  // Last resort: first ISO date in document
  if (!txDate) {
    const anyDate = text.match(/\b(202\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/);
    if (anyDate) txDate = anyDate[1];
  }

  return { insiderName, viaEntity, role, company, isin, txType, shares, price, currency, txDate };
}

async function parsePdfFromUrl(pdfUrl) {
  if (!pdfUrl) return {};
  try {
    const parser = new PDFParse({ url: pdfUrl });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    return parsePdfText(result.text || '');
  } catch {
    return {};
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeIT() {
  console.log('🇮🇹  eMarket STORAGE Italy — MAR Art. 19 internal dealing (PDF)');
  const t0 = Date.now();
  const co = cutoff();
  console.log(`  Retention window: ${toIsoDate(co)} → today`);

  // Step 1: collect all filing metadata from paginated HTML results
  const filings = await fetchAllFilings(co);
  if (filings.length === 0) {
    console.log('  No filings found in retention window.');
    return { saved: 0 };
  }
  console.log(`  Found ${filings.length} filings — fetching PDFs…`);

  // Step 2: fetch and parse PDFs in concurrent batches
  const rows = [];
  let pdfFailed = 0, pdfDebt = 0, pdfZero = 0;

  for (let i = 0; i < filings.length; i += PDF_CONCURRENCY) {
    const batch = filings.slice(i, i + PDF_CONCURRENCY);
    const results = await Promise.all(
      batch.map(f => parsePdfFromUrl(f.pdfUrl).then(pdf => ({ f, pdf })))
    );

    for (const { f, pdf } of results) {
      if (pdf._skipped === 'debt')       { pdfDebt++; continue; }
      if (pdf._skipped === 'zero_price') { pdfZero++; continue; }
      if (!pdf.txType) { pdfFailed++; continue; }

      const company = pdf.company || f.company;
      const txDate  = pdf.txDate  || f.txDate;
      const shares  = pdf.shares  ?? null;
      const price   = pdf.price   ?? null;

      rows.push({
        filing_id:        `IT-${f.proto}`,
        country_code:     COUNTRY_CODE,
        source:           SOURCE,
        ticker:           getTicker(company),
        company,
        insider_name:     pdf.insiderName || null,
        via_entity:       pdf.viaEntity   || null,
        insider_role:     pdf.role || 'Not disclosed',
        transaction_type: pdf.txType,
        transaction_date: txDate,
        shares,
        price_per_share:  price,
        total_value:      (price != null && shares) ? Math.round(price * shares) : null,
        currency:         pdf.currency || CURRENCY,
        filing_url:       f.pdfUrl || `https://${HOST}/it/comunicati-finanziari`,
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
  console.log(`  Parsed ${rows.length}/${filings.length} (${parseRate}% equity, ${pdfDebt} bond, ${pdfZero} zero-price, ${pdfFailed} failed)`);

  if (rows.length === 0) {
    console.log('  No BUY/SELL transactions extracted.');
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

scrapeIT().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
