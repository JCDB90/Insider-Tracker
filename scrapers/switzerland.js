/**
 * CH — Insider Transactions Scraper
 *
 * Source: SIX Exchange Regulation (SER-AG) — Management Transactions
 * URL: https://www.ser-ag.com/en/resources/notifications-market-participants/management-transactions.html
 *
 * API: https://www.ser-ag.com/sheldon/management_transactions/v1/overview.json
 *   pageSize, pageNumber, sortAttribute=byDate (newest first)
 *
 * Note: fromDate/toDate filter on submission/notification date (not transaction date).
 *   The transactionDate field in the response is the actual trade date.
 *   We paginate without date filtering and stop when transactionDate falls before cutoff.
 *
 * API discovered by reverse-engineering the React component JS bundle at
 * /etc.clientlibs/ser/components/react/ser/management-transactions/clientlibs.min.*.js
 *
 * Fields: notificationSubmitter (issuer), ISIN, transactionDate (YYYYMMDD int),
 *         transactionSize (shares), transactionAmountPerSecurityCHF (price),
 *         transactionAmountCHF (total), buySellIndicator (1=Buy, 2=Sell)
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { isinToTicker }            = require('./lib/isinToTicker');

const COUNTRY_CODE   = 'CH';
const SOURCE         = 'SIX Exchange Regulation';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'CHF';
const PAGE_SIZE      = 100;
const MAX_PAGES      = 20;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toIntDate(d) {
  return parseInt(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`, 10);
}
function intDateToIso(n) {
  const s = String(n);
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function mapType(indicator) {
  if (indicator === '1') return 'BUY';
  if (indicator === '2') return 'SELL';
  return 'OTHER';
}

function fetchPage(pageNumber) {
  return new Promise((resolve) => {
    const qs = `pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}&sortAttribute=byDate`;
    const req = https.get({
      hostname: 'www.ser-ag.com',
      path: `/sheldon/management_transactions/v1/overview.json?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.ser-ag.com/en/resources/notifications-market-participants/management-transactions.html',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function scrapeCH() {
  console.log('🇨🇭  SIX Exchange Regulation — management transactions');
  const t0      = Date.now();
  const co      = cutoff();
  const from    = isoDate(co);
  const to      = isoDate(new Date());
  const cutoffInt = toIntDate(co);
  console.log(`  Fetching ${from} → ${to} (paginating newest-first, stopping at cutoff)…`);

  // Paginate without date filter; API sorts newest-first by transactionDate.
  // Stop when all items on a page are older than the cutoff.
  const allItems = [];
  const seenIds  = new Set();
  let page = 0;  // SER-AG API is 0-indexed

  while (page <= MAX_PAGES) {
    const data = await fetchPage(page);
    if (!data) {
      if (page === 1) {
        console.log('  ⚠  SER-AG API not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }
    if (data.status !== 'Ok') break;

    const items = data.itemList || [];
    if (!items.length) break;

    let allBefore = true;
    for (const item of items) {
      const tDate = item.transactionDate || 0;  // YYYYMMDD integer
      if (tDate >= cutoffInt) {
        allBefore = false;
        const id = item.notificationId || `${item.ISIN}-${tDate}-${item.transactionSize}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allItems.push(item);
        }
      }
    }

    console.log(`  Page ${page}: ${items.length} items, ${allItems.length} in window so far`);

    if (allBefore) { console.log('  All items before cutoff, stopping.'); break; }
    if (items.length < PAGE_SIZE) break;
    page++;
  }

  if (!allItems.length) {
    console.log('  No management transactions in window.');
    return { saved: 0 };
  }

  // transactionSize is sometimes NOT a real share count — it's a fixed "1"
  // used as an administrative placeholder for share-based compensation or
  // scrip-dividend elections where the actual number of shares to be
  // delivered isn't known yet, because it depends on a FUTURE price
  // (a volume-weighted average, or a specific future closing price) not yet
  // observed at filing time. Confirmed live across many companies — Adecco's
  // scrip dividend "die effektive Anzahl der neuen Aktien wird errechnet..."
  // over 9 future trading days; UBS board comp "Durchschnittspreis...
  // Stichtag wird im Dezember/Januar festgelegt"; Roche Connect's plan
  // literally states "the number of future ROP can not be calculated in
  // advance and is set as 1"; Alcon/Sandoz "will be calculated by dividing
  // the awarded amount by the closing share price on [future date]";
  // explicitly spelled out on Banque Cantonale de Genève: "le nombre total
  // des actions n'est pas connu à ce jour". In every one of these,
  // transactionAmountPerSecurityCHF is really the CASH VALUE of the
  // entitlement (transactionAmountCHF always equals it exactly, since
  // total = price × 1), not a genuine per-share price — there is no real
  // share count anywhere to recover, unlike the France PRIX/VOLUME swap bug,
  // so the row is skipped rather than corrected.
  //
  // Wording varies enough (BELIMO's own phrasing, "in diskontierten
  // gesperrten Aktien ausbezahlt", mentions none of the above keywords at
  // all) that a keyword list alone misses real cases. A second, language-
  // independent signal catches the rest: build a per-ISIN reference price
  // from this batch's OWN genuine transactionSize > 1 entries (a real,
  // unambiguous per-share price) and flag any transactionSize === 1 entry
  // whose price is wildly off that reference (confirmed: BELIMO's other
  // filings in the same window show CHF 760-846/share; several of its
  // transactionSize=1 rows show CHF 16,571-325,714 — 20-390x off). A
  // genuine transactionSize=1 trade (Chocoladefabriken Lindt & Sprüngli,
  // ~CHF 90,000+/share; Zuger Kantonalbank, ~CHF 10,650/share — both
  // confirmed live, among the most expensive stocks on the exchange) has no
  // such same-batch reference to contradict it, or its price falls right in
  // line with one.
  const referencePrices = new Map(); // ISIN -> [prices from genuine multi-share trades]
  for (const r of allItems) {
    const size = r.transactionSize != null ? Math.abs(Number(r.transactionSize)) : null;
    const price = r.transactionAmountPerSecurityCHF != null ? Number(r.transactionAmountPerSecurityCHF) : null;
    if (r.ISIN && size > 1 && price > 0) {
      if (!referencePrices.has(r.ISIN)) referencePrices.set(r.ISIN, []);
      referencePrices.get(r.ISIN).push(price);
    }
  }
  function referenceMedian(isin) {
    const arr = referencePrices.get(isin);
    if (!arr || !arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  const seen = new Set();
  const dbRows = [];
  let skippedPending = 0;

  for (const r of allItems) {
    const txIso   = r.transactionDate ? intDateToIso(r.transactionDate) : from;
    let shares    = r.transactionSize != null ? Math.round(Math.abs(Number(r.transactionSize))) : null;
    const price   = r.transactionAmountPerSecurityCHF != null ? Number(r.transactionAmountPerSecurityCHF) : null;
    const total   = r.transactionAmountCHF != null ? Math.round(Math.abs(Number(r.transactionAmountCHF))) : null;
    const fid     = `CH-${r.notificationId || r.ISIN + '-' + r.transactionDate + '-' + String(shares||0)}`;

    if (seen.has(fid)) continue;
    seen.add(fid);

    const narrative = `${r.transactionConditions || ''} ${r.securityDescription || ''}`.replace(/\s+/g, ' ');
    const keywordMatch = /durchschnitt|festgelegt|stichtag|VWAP|volume.weighted|schlusskurs|closing.{0,30}(?:share\s+)?price|corresponds?\s+to\s+the\s+transaction\s+value|n.est\s+pas\s+connu|d.pendra\s+du\s+cours|not\s+yet\s+(?:known|determined)|to\s+be\s+determined|can(?:not|\s+not)\s+be\s+calculated|will\s+be\s+calculated\s+by\s+dividing|is\s+set\s+as\s+1\b/i.test(narrative);
    const refMedian = shares === 1 && price ? referenceMedian(r.ISIN) : null;
    const priceOffReference = refMedian != null && (price > refMedian * 5 || price < refMedian / 5);
    const isPendingShareCount = shares === 1 && (keywordMatch || priceOffReference);
    if (isPendingShareCount) { skippedPending++; shares = null; }

    const ticker = r.ISIN ? (await isinToTicker(r.ISIN, COUNTRY_CODE) || '') : '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company:          r.notificationSubmitter || null,
      insider_name:     'Not disclosed',  // SER-AG public API does not disclose individual names
      insider_role:     'Not disclosed',
      transaction_type: mapType(r.buySellIndicator),
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      total,
      currency:         CURRENCY,
      filing_url:       `https://www.ser-ag.com/en/resources/notifications-market-participants/management-transactions.html`,
      source:           SOURCE,
    });
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  const other = dbRows.filter(r => r.transaction_type === 'OTHER').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL, ${other} OTHER) | pending-share-count skipped: ${skippedPending}`);
  return { saved: dbRows.length };
}

scrapeCH().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
