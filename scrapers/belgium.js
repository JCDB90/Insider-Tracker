/**
 * BE — Insider Transactions Scraper
 *
 * Source: FSMA (Financial Services and Markets Authority) Belgium
 * URL: https://www.fsma.be/en/transaction-search
 *
 * The FSMA publishes MAR Article 19 insider transaction notifications via:
 *   1. A searchable Drupal Views list page (/en/transaction-search?date[min]=...&date[max]=...)
 *      Returns columns: Publication Date | Issuer | Notifying Person
 *      With links to individual transaction pages.
 *
 *   2. Individual detail pages (/en/manager-transaction/<slug>) with full structured data:
 *      - Date of publication
 *      - Notifying person (insider name)
 *      - Declarer Type (role)
 *      - Issuer (company)
 *      - Instrument Type
 *      - Instrument ISIN Code
 *      - Transaction Type (Acquisition / Sale / Disposal)
 *      - Transaction Date
 *      - Transaction Currency
 *      - Transaction Quantity (shares)
 *      - Transaction Price (per share)
 *      - Transaction Amount (total)
 *
 * Strategy:
 *   1. Fetch list page with date filter to get transaction slugs.
 *   2. Fetch each detail page (in batches of 5 concurrent).
 *   3. Parse all fields and save to Supabase.
 *
 * The FSMA view shows up to 50 results per date window. For a 14-day retention
 * window, this is sufficient for Belgium's transaction volume.
 *
 * Fields available: ALL structured fields (no PDF parsing required).
 */
'use strict';

const https   = require('https');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'BE';
const SOURCE         = 'FSMA Belgium';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';
const CONCURRENCY    = 5;   // parallel detail page fetches

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function fetchHtml(path) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'www.fsma.be',
      path,
      headers: HEADERS,
    }, res => {
      // Follow redirect
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location || '';
        const newPath = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
        res.resume();
        return resolve(fetchHtml(newPath));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// ─── List page ───────────────────────────────────────────────────────────────

async function fetchTransactionLinks(from, to) {
  const links = new Set();
  let page = 0;
  while (true) {
    const qs = page === 0
      ? `/en/transaction-search?date%5Bmin%5D=${from}&date%5Bmax%5D=${to}`
      : `/en/transaction-search?date%5Bmin%5D=${from}&date%5Bmax%5D=${to}&page=${page}`;
    const html = await fetchHtml(qs);
    if (!html) break;
    const $ = cheerio.load(html);
    let added = 0;
    $('a[href^="/en/manager-transaction/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!links.has(href)) { links.add(href); added++; }
    });
    // If no new links on this page, we've exhausted results
    if (added === 0) break;
    // Check if there's a "next page" link
    const hasNext = $('a[rel="next"], .pager__item--next a').length > 0;
    if (!hasNext) break;
    page++;
    if (page > 20) break;  // safety cap
  }
  return [...links];
}

// ─── Detail page parser ───────────────────────────────────────────────────────

function extractField($, cssClass) {
  return $(`.field--name-${cssClass} .field__item`).first().text().trim()
      || $(`.field--name-${cssClass} time`).first().attr('datetime')?.slice(0, 10)
      || '';
}

function parseDetailPage(html, slug) {
  const $ = cheerio.load(html);

  const pubDate    = extractField($, 'field-ct-date-time');     // "10/04/2026"
  const txDate     = $('.field--name-field-ct-transaction-date time').first().attr('datetime')?.slice(0, 10)
                   || pubDate;
  const company    = extractField($, 'field-ct-issuer');
  const insiderName = extractField($, 'field-ct-declarer-name');
  const roleRaw    = extractField($, 'field-ct-declarer-type');
  const isin       = extractField($, 'field-ct-instrument-isin-code');
  const txTypeRaw  = extractField($, 'field-ct-transaction-type');
  const currency   = extractField($, 'field-ct-transaction-currency') || CURRENCY;

  // Quantity / Price / Amount – prefer the content attribute (raw number)
  const sharesEl  = $('.field--name-field-ct-transaction-quantity .field__item').first();
  const priceEl   = $('.field--name-field-ct-price .field__item').first();
  const amountEl  = $('.field--name-field-ct-amount .field__item').first();

  // Helper: extract a number from an element, preferring the machine-readable `content`
  // attribute but falling back to visible text (handles European "1.234,56" format).
  function parseFieldNum(el) {
    const raw = el.attr('content');
    if (raw != null && raw !== '') {
      const n = parseFloat(raw);
      return isNaN(n) ? null : Math.abs(n);
    }
    const txt = el.text().replace(/\s/g, '');
    if (!txt) return null;
    // Detect European format: "1.234,56" → 1234.56
    const isEuropean = /\d\.\d{3},\d/.test(txt);
    const norm = isEuropean
      ? txt.replace(/\./g, '').replace(',', '.')
      : txt.replace(/,/g, '');
    const n = parseFloat(norm);
    return isNaN(n) ? null : Math.abs(n);
  }

  const price     = parseFieldNum(priceEl);
  const totalVal  = parseFieldNum(amountEl)  != null ? Math.round(parseFieldNum(amountEl))  : null;
  const sharesRaw = parseFieldNum(sharesEl)  != null ? Math.round(parseFieldNum(sharesEl))  : null;
  // Derive shares from total/price when the quantity field is missing but both values are present and non-zero
  const shares    = sharesRaw ?? ((price && price > 0 && totalVal && totalVal > 0) ? Math.round(totalVal / price) : null);

  // Map transaction type to BUY / SELL
  const txType = (() => {
    const t = txTypeRaw.toLowerCase();
    if (t.includes('acqui') || t.includes('subscription') || t.includes('purchase') || t.includes('buy')) return 'BUY';
    if (t.includes('sale') || t.includes('disposal') || t.includes('sell')) return 'SELL';
    return 'OTHER';
  })();

  // Parse pub date DD/MM/YYYY → YYYY-MM-DD
  function parseDate(ddmmyyyy) {
    if (!ddmmyyyy) return null;
    const [d, m, y] = ddmmyyyy.split('/');
    if (!d || !m || !y) return ddmmyyyy;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  return {
    slug,
    pubDate:     parseDate(pubDate) || txDate,
    txDate:      txDate || parseDate(pubDate),
    company,
    insiderName,
    role:        translateRole(roleRaw),
    isin,
    txType,
    currency,
    shares,
    price,
    totalVal,
    url: `https://www.fsma.be/en/manager-transaction/${slug.replace(/^\/en\/manager-transaction\//, '')}`,
  };
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function mapConcurrent(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeBE() {
  console.log('🇧🇪  FSMA Belgium — MAR Article 19 manager transactions');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // Step 1: Get list of transaction links
  const links = await fetchTransactionLinks(from, to);
  if (!links.length) {
    console.log('  ⚠  FSMA transaction-search returned no results or is not accessible.');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }
  console.log(`  Found ${links.length} transaction links`);

  // Step 2: Fetch detail pages concurrently
  console.log(`  Fetching detail pages (${CONCURRENCY} concurrent)…`);
  const details = await mapConcurrent(links, async (link) => {
    const html = await fetchHtml(link);
    if (!html) return null;
    const slug = link.replace('/en/manager-transaction/', '');
    return parseDetailPage(html, slug);
  }, CONCURRENCY);

  // Step 3: Build DB rows
  const seen    = new Set();
  const dbRows  = [];
  const cutoffIso = from;

  for (const d of details) {
    if (!d) continue;

    // Filter to retention window by transaction date
    const dateForFilter = d.txDate || d.pubDate;
    if (dateForFilter && dateForFilter < cutoffIso) continue;

    const slug = d.slug.replace(/^\/en\/manager-transaction\//, '');
    const fid  = `BE-${slug}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           d.isin || '',
      company:          d.company || null,
      insider_name:     d.insiderName || null,
      insider_role:     d.role || null,
      transaction_type: d.txType,
      transaction_date: d.txDate || d.pubDate,
      shares:           d.shares,
      price_per_share:  d.price,
      total_value:      d.totalVal,
      currency:         d.currency,
      filing_url:       d.url,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) {
    console.log('  Nothing to save after filtering.');
    return { saved: 0 };
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeBE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
