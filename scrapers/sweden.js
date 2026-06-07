/**
 * Sweden (SE) — Insider Transactions Scraper
 *
 * Source: Finansinspektionen (FI) — Insynsregistret
 * URL: https://marknadssok.fi.se/Publiceringsklient/en-GB/Search/Search
 *
 * Strategy: pagination via publication-date filter + AJAX partial endpoint.
 *
 *   Key findings from investigation (2026-06-06/07):
 *   - Publication-date filter tried but rejected: some filings (e.g. Investor AB)
 *     appear only under transaction date — FI can delay the publication date by
 *     several days after the actual transaction.
 *   - Transaction-date 2-day window = ~20–30 rows / 2–3 pages → no rate limiting.
 *     Old 14-day window = 836 results / 84 pages → rate-limit ECONNRESET cascade.
 *   - AJAX partial endpoint (/Search/Insyn?paging=True) is NOT IP-blocked from
 *     Hetzner datacenter IPs (unlike the CSV export endpoint).  Returns 15KB vs 29KB
 *     per page (47% smaller).  Used for pages 2+; page 1 uses the full URL to get
 *     the pager metadata (total pages).
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');
const { isinToTicker }           = require('./lib/isinToTicker');
const { contentId }              = require('./lib/contentId');

const COUNTRY_CODE = 'SE';
const SOURCE       = 'Finansinspektionen Sweden';
// Transaction-date window.  2 days captures yesterday + today reliably.
// Publication date was tried but some filings (e.g. Investor AB) appear under
// transaction date only — FI can delay the public-date by days after the tx date.
// 2-day tx window = ~20–30 rows / 2–3 pages → no rate-limit issues.
// Set LOOKBACK_DAYS=14 (or higher) for backfills.
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '2');
const DELAY_MS      = 1200;  // ~8 reqs/min — avoids ECONNRESET rate-limit on AJAX endpoint
const BASE          = 'https://marknadssok.fi.se/Publiceringsklient/en-GB/Search/Search';
const AJAX_BASE     = `${BASE}/Insyn`;
const HEADERS       = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseSEDate(s) {
  if (!s) return null;
  const [d, m, y] = s.trim().split('/');
  const dt = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  return isNaN(dt) ? null : dt;
}
function parseNum(s) {
  if (!s || s.trim() === '-') return null;
  const str = s.trim().replace(/\s/g, '');
  if (!str) return null;
  // European decimal with thousands: "1.234,56" → 1234.56
  if (/\d\.\d{3},/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  // Period-only thousands: "1.234.567" → 1234567.
  // Requires 2+ groups: "1.178" has only one group and is a decimal, not thousands.
  if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(str)) return parseFloat(str.replace(/\./g, ''));
  // Comma-only thousands with 2+ groups: "1,234,567" → 1234567
  // Single-group "44,025" is Nordic decimal 44.025, not thousands — handled below.
  if (/^\d{1,3}(?:,\d{3}){2,}$/.test(str)) return parseFloat(str.replace(/,/g, ''));
  // Comma as decimal (Nordic): "44,025" → 44.025; "129,75" → 129.75
  if (/,/.test(str) && !/\./.test(str)) return parseFloat(str.replace(',', '.'));
  return parseFloat(str.replace(/,/g, ''));
}

// Share/volume counts are always integers — strip all separators (comma, period, space).
// "100,000" → 100000; "18,323" → 18323; "1.234.567" → 1234567.
// Never treat comma as decimal for counts.
function parseShares(s) {
  if (!s) return null;
  const n = parseInt(String(s).trim().replace(/[^\d]/g, ''), 10);
  return isNaN(n) || n === 0 ? null : n;
}
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('subscript') || l.includes('grant') ||
      l.includes('purchas') || l.includes('receiv') || l.includes('gift') ||
      l.includes('award') || l.includes('exercis') || l.includes('convert') ||
      l.includes('inherit') || l.includes('allotm')) return 'BUY';  // "Allotment" = RSU/LTIP grant
  if (l.includes('dispos') || l.includes('sale') || l.includes('redem') ||
      l.includes('divest')) return 'SELL';
  return 'OTHER';
}

const TICKERS = {
  // Large caps with share classes
  'evolution': 'EVO', 'hexagon': 'HEXA-B', 'ericsson': 'ERIC-B',
  'betsson': 'BETS-B', 'kindred': 'KIND-SDB', 'i-tech': 'ITECH',
  'volvo cars': 'VOLCAR-B', 'volvo': 'VOLV-B',
  'abb': 'ABB', 'atlas copco': 'ATCO-A', 'investor': 'INVE-B',
  'essity': 'ESSITY-B', 'sandvik': 'SAND',
  'handelsbanken': 'SHB-A', 'swedbank': 'SWED-A',
  'seb ': 'SEB-A',  // trailing space prevents matching "sebago" etc.
  'nordea': 'NDA-SE', 'alfa laval': 'ALFA', 'nibe': 'NIBE-B',
  'sinch': 'SINCH', 'tele2': 'TEL2-B', 'telia': 'TELIA',
  'boliden': 'BOL', 'h&m': 'HM-B', 'hennes & mauritz': 'HM-B',
  'autoliv': 'ALIV-SDB', 'elekta': 'EKTA-B',
  'getinge': 'GETI-B', 'ssab': 'SSAB-A',
  'husqvarna': 'HUSQ-B', 'skanska': 'SKA-B',
  // Additional commonly-filed companies — prevents "AB X" → "AB" ticker bug
  'electrolux': 'ELUX-B',
  'kinnevik': 'KINV-B',
  'industrivärden': 'INDU-C', 'industrivarden': 'INDU-C',
  'lifco': 'LIFCO-B',
  'saab': 'SAAB-B',
  'castellum': 'CAST',
  'fastighets': 'FASTU-B',
  'fingerprint': 'FING-B',
  'midsona': 'MIDS-B',
  'nyfosa': 'NYF',
  'epiroc': 'EPI-B',
  'viaplay': 'VPLAY-B',
  'elanders': 'ELAN-B',
  'hexpol': 'HEXPOL-B',
  'lundbergs': 'LUND-B',
  'latour': 'LATO-B',
  'ica gruppen': 'ICA',
  'addtech': 'ADDT-B',
  'addnode': 'ADDN-B',
  'bilia': 'BILI-A',
  'thule': 'THULE',
  'nolato': 'NOLA-B',
  'troax': 'TROAX',
  'vitec': 'VIT-B',
  // Extended — companies that hit 6-char truncation bug or have special tickers
  'indutrade': 'INDT',
  'dometic': 'DOM',          // DOM.ST (was wrongly DOMETIC)
  'eeducation albert': 'ALBER',
  'medicover': 'MCOV-B',
  'avanza bank': 'AZA',
  'avanza': 'AZA',
  'scandic hotels': 'SCST', // SCST.ST (was wrongly SCAND)
  'diös fastigheter': 'DIOS',
  'dios fastigheter': 'DIOS',
  'cellavision': 'CEVI',
  'fabege': 'FABG',
  'bonava': 'BONA-B',
  'platzer fastigheter': 'PLAZ',
  'swedencare': 'SWED-B',
  'humana ab': 'HUMA',
  'nordnet': 'NORDNET',
  'flowscape': 'FLOW-B',
  'greater than': 'GREAT',

  // ── Broken-ticker fixes (confirmed correct Yahoo Finance symbols) ──────────
  // Previously these companies had no working chart because the auto-derived
  // ticker (6-char name truncation) didn't match any Yahoo Finance symbol.
  'lindab': 'LIAB',         // LIAB.ST  (was LINDAB — no Yahoo listing)
  'alleima': 'ALLEI',       // ALLEI.ST (Sandvik spin-off, was ALLEIM)
  'proact it': 'PACT',      // PACT.ST  (was PROACT)
  'proact': 'PACT',
  'nederman': 'NMAN',       // NMAN.ST  (was NEDERM)
  'fagerhult': 'FAG',       // FAG.ST   (was FAGERH)
  'ework group': 'EWRK',    // EWRK.ST  (was EWORK)
  'ework': 'EWRK',
  'invisio': 'IVSO',        // IVSO.ST  (was INVISI)
  'bonesupport': 'BONEX',   // BONEX.ST (was BONESU)
  'teqnion': 'TEQ',         // TEQ.ST   (was TEQNIO)
  'pandox': 'PNDX-B',       // PNDX-B.ST (was PANDOX)
  'samhällsbyggnadsbolaget': 'SBB-B', // SBB-B.ST (was SAMHÄL with ä)
  'samhallsbyggnadsbolaget': 'SBB-B', // ASCII fallback
  'addlife': 'ALIF-B',      // ALIF-B.ST (was ADDLIF)
  'add life': 'ALIF-B',

  // ── Fallback-to-primary fixes (chart loaded via alt symbol, now use correct) ─
  // These companies' charts worked but loaded via a secondary candidate symbol.
  // Setting the correct primary avoids the extra API calls.
  'assa abloy': 'ASSA-B',   // ASSA-B.ST  (was ASSA → tries ASSA-B.ST 3rd)
  'ncc ': 'NCC-B',          // NCC-B.ST   (trailing space avoids matching "BNCC")
  'securitas': 'SECU-B',    // SECU-B.ST  (was SECURI)
  'billerud': 'BILL',       // BILL.ST    (was BILLER)
  'sweco': 'SWEC-B',        // SWEC-B.ST  (was SWECO)
  'trelleborg': 'TREL-B',   // TREL-B.ST  (was TRELLE)
  'truecaller': 'TRUE-B',   // TRUE-B.ST  (was TRUECA)
  'wallenstam': 'WALL-B',   // WALL-B.ST  (was WALLEN)
  'storytel': 'STORY-B',    // STORY-B.ST (was STORYT; STOR-B.ST is Storskogen)
  'dustin': 'DUST',         // DUST.ST    (was DUSTIN)
  'holmen': 'HOLM-B',       // HOLM-B.ST  (was HOLMEN)
  'rejlers': 'REJL-B',      // REJL-B.ST  (was REJLER)
  'ratos': 'RATO-B',        // RATO-B.ST  (was RATOS)
  'nobia': 'NOBI',          // NOBI.ST    (was NOBIA)
  'logistea': 'LOGIST-B',   // LOGIST-B.ST (was LOGIST)
  'knowit': 'KNOW',         // KNOW.ST    (was KNOWIT)
  'bergman & beving': 'BERG-B', // BERG-B.ST
  // ── Companies whose first word is ambiguous / misleading ──────────────────
  'investment aktiebolaget spiltan': 'SPILTAN', // SPILTAN.ST — auto-derive gives "INVEST" (wrong)
};
function getTicker(n) {
  if (!n) return null;
  const l = n.toLowerCase();
  for (const [k, v] of Object.entries(TICKERS)) if (l.includes(k)) return v;
  // Strip leading "AB " (Aktiebolag = Swedish "Inc.") and trailing " AB (publ)"
  // to prevent "AB Electrolux" → "AB" which Yahoo Finance maps to AllianceBernstein (US)
  const clean = n
    .replace(/^AB\s+/i, '')
    .replace(/\s+AB(?:\s+\(publ\))?\.?\s*$/i, '')
    .trim();
  return clean.split(/\s+/)[0].toUpperCase().slice(0, 6) || null;
}

// Returns { rows, totalPages } for page 1; { rows } for subsequent pages.
// Page 1 uses the full search URL (needed to read pager metadata).
// Pages 2+ use the AJAX partial endpoint — 47% smaller, same column layout,
// not IP-blocked from datacenter IPs unlike the CSV export endpoint.
async function fetchPage(from, to, page) {
  // Page 1 (full HTML): ISO dates work fine.
  // Pages 2+ (AJAX partial endpoint): ISO dates are silently IGNORED — the server
  // returns recently-published data regardless of the date param.  Must use
  // DD%2FMM%2FYYYY (URL-encoded slashes) to match what the server puts in pager links.
  const toDMY   = to.split('-').reverse().join('%2F');    // 2026-06-07 → 07%2F06%2F2026
  const fromDMY = from.split('-').reverse().join('%2F');
  const url = page === 1
    ? `${BASE}?SearchFunctionType=Insyn&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}&Page=1`
    : `${AJAX_BASE}?button=search&SearchFunctionType=Insyn&paging=True` +
      `&Transaktionsdatum.From=${fromDMY}&Transaktionsdatum.To=${toDMY}&page=${page}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);

  const rows = [];
  $('tbody tr').each((_, tr) => {
    const c = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
    if (c.length < 13) return;
    rows.push({
      company: c[1], insider: c[2], position: c[3], closely: c[4] || null,
      nature:  c[5], isin:    c[8], txDateStr: c[9],
      volume:  c[10], price:  c[12], currency: c[13] || 'SEK',
    });
  });

  // Extract total page count and result count from pager on page 1.
  // Must use cheerio attr() — raw HTML has &amp;page=N (entity-encoded) which
  // a plain regex on the HTML string would not match.
  let totalPages = null, totalResults = null;
  if (page === 1) {
    const pageNums = [];
    $('a[href]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/[?&]page=(\d+)/i);
      if (m) pageNums.push(parseInt(m[1]));
    });
    totalPages = pageNums.length ? Math.max(...pageNums) : 1;
    // "Showing X to Y of Z result" — Z is in the badge-info span
    const badge = $('.badge-info').first().text().trim();
    if (badge) totalResults = parseInt(badge);
  }

  return { rows, totalPages, totalResults };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// Three-pass fetch: Pass 1 sweeps all pages; Passes 2+3 retry any that were
// rate-limited (ECONNRESET) with increasing waits to let the server throttle reset.
async function fetchAllPages(from, to) {
  const allRows  = [];
  let totalPages = null, totalResults = null;

  // ── Pass 1: sequential sweep ───────────────────────────────────────────────
  const failedPages = [];
  for (let page = 1; ; page++) {
    if (totalPages !== null && page > totalPages) break;
    process.stdout.write(`  p${page}${totalPages ? `/${totalPages}` : ''}… `);

    let result = null;
    try {
      result = await fetchPage(from, to, page);
    } catch (err) {
      console.warn(`FAIL (${err.message.slice(0, 40)})`);
      failedPages.push(page);
      await delay(DELAY_MS);
      continue;
    }

    if (page === 1) {
      totalPages   = result.totalPages;
      totalResults = result.totalResults;
      console.log(`\n  Total: ${totalResults ?? '?'} results / ${totalPages} page(s)`);
      process.stdout.write(`  p1… `);
    }
    console.log(`${result.rows.length} rows`);
    allRows.push(...result.rows);
    if (result.rows.length < 10) break;
    if (page < (totalPages ?? Infinity)) await delay(DELAY_MS);
  }

  // ── Pass 2: retry after 30s ────────────────────────────────────────────────
  if (failedPages.length > 0) {
    console.log(`  ⏳ ${failedPages.length} page(s) rate-limited [${failedPages.join(',')}] — waiting 30s…`);
    await delay(30000);
    const stillFailed = [];
    for (const page of failedPages) {
      process.stdout.write(`  retry p${page}… `);
      try {
        const result = await fetchPage(from, to, page);
        console.log(`${result.rows.length} rows`);
        allRows.push(...result.rows);
      } catch (err) {
        console.warn(`FAIL`);
        stillFailed.push(page);
      }
      await delay(2500);
    }

    // ── Pass 3: final retry after 60s ───────────────────────────────────────
    if (stillFailed.length > 0) {
      console.log(`  ⏳ ${stillFailed.length} page(s) still failing [${stillFailed.join(',')}] — waiting 60s…`);
      await delay(60000);
      for (const page of stillFailed) {
        process.stdout.write(`  final p${page}… `);
        try {
          const result = await fetchPage(from, to, page);
          console.log(`${result.rows.length} rows`);
          allRows.push(...result.rows);
        } catch (err) {
          console.error(`FAIL — permanently missed`);
        }
        await delay(2500);
      }
    }
  }

  const reported = totalResults ?? ((totalPages ?? 0) * 10);
  console.log(`  Coverage: ${allRows.length} rows fetched (reported total: ${reported})`);
  return allRows;
}

async function scrapeSE() {
  console.log('🇸🇪  Finansinspektionen Sweden — Insynsregistret');
  const t0 = Date.now();

  const txTo   = new Date();
  const txFrom = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const from = isoDate(txFrom), to = isoDate(txTo);

  console.log(`  Transaction dates ${from} → ${to} (LOOKBACK_DAYS=${LOOKBACK_DAYS})…`);

  const allRaw = await fetchAllPages(from, to);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const { looksLikeCorp } = require('./lib/entityUtils');
  const seen = new Set();
  const dbRows = [];
  let corpFilings = 0;
  for (const r of allRaw) {
    const txDate = parseSEDate(r.txDateStr);
    // No transaction-date cutoff: pub-date is the time anchor.  Skip only if unparseable.
    if (!txDate) continue;
    const txIso = isoDate(txDate);
    const shares = parseShares(r.volume), price = parseNum(r.price);
    const total = (shares && price) ? Math.round(shares * price) : null;
    // Content-based ID: excludes ISIN to prevent duplicate entries when the same
    // person/transaction matches two different instrument ISINs in the FI search.
    const txType = mapType(r.nature);
    const fid = contentId(COUNTRY_CODE, r.company, r.insider, txType, txIso, shares, price);
    if (seen.has(fid)) continue;
    seen.add(fid);

    // Log closely-associated or corporate entity filings for visibility
    // (looksLikeCorp rows will be dropped by saveInsiderTransactions — log here first)
    if (r.insider && looksLikeCorp(r.insider)) {
      console.log(`  ⚠  Corp entity insider: "${r.insider}" @ ${r.company} on ${txIso} (type: ${r.nature}, closely: ${r.closely || 'n/a'})`);
      corpFilings++;
    }

    dbRows.push({
      filing_id: fid, country_code: COUNTRY_CODE,
      ticker: getTicker(r.company), _isin: r.isin || null,
      company: r.company || null,
      insider_name: r.insider || null, insider_role: translateRole(r.position) || null,
      transaction_type: txType, transaction_date: txIso,
      shares: shares !== null ? Math.round(shares) : null,
      price_per_share: price, total_value: total, currency: r.currency,
      filing_url: `${BASE}?SearchFunctionType=Insyn&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}`,
      source: SOURCE,
    });
  }
  if (corpFilings) console.log(`  ℹ  ${corpFilings} corporate-entity insider rows detected (will be dropped by db filter)`);

  console.log(`  ${dbRows.length} unique rows`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  // ISIN fallback: resolve ticker via Yahoo for rows where company-name lookup failed
  let isinResolved = 0;
  for (const r of dbRows) {
    if (!r.ticker && r._isin) {
      const t = await isinToTicker(r._isin, COUNTRY_CODE);
      if (t) { r.ticker = t; isinResolved++; }
      await new Promise(res => setTimeout(res, 120));
    }
  }
  if (isinResolved) console.log(`  Resolved ${isinResolved} tickers via ISIN lookup`);

  // Strip temporary _isin field before DB save
  const saveRows = dbRows.map(({ _isin, ...rest }) => rest);

  const { error } = await saveInsiderTransactions(saveRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys = saveRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = saveRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${saveRows.length} saved (${buys} BUY, ${sells} SELL)`);
  console.log(`  Sample: ${saveRows.slice(0,3).map(r=>`${r.company}/${r.transaction_type}`).join(', ')}`);
  return { saved: saveRows.length };
}

scrapeSE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
