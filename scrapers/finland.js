/**
 * FI — Insider Transactions Scraper
 *
 * Source: Nasdaq Helsinki — Managers' Transactions (MAR Article 19)
 * API:    https://api.news.eu.nasdaq.com/news/query.action (JSONP)
 *         market=Main+Market%2C+Helsinki
 *         cnsCategory=Managers%27+Transactions
 *
 * Full notification HTML fetched from view.news.eu.nasdaq.com for structured data.
 * Returns up to 200 items per page; paginated via start= offset.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');
const { isinToTicker }           = require('./lib/isinToTicker');

const COUNTRY_CODE   = 'FI';
const SOURCE         = 'Nasdaq Helsinki / MAR';
const RETENTION_DAYS = 90;
const CURRENCY       = 'EUR';
const MARKET         = 'Main Market, Helsinki';
const CONCURRENCY    = 8;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  // SELL first: prevents "buyback" matching "buy" before "sale" check runs
  if (l.includes('dispos') || l.includes('sale') || l.includes('sell')) return 'SELL';
  if (l.includes('acqui') || l.includes('receipt') || l.includes('grant') ||
      l.includes('subscribe') || l.includes('exercise') || /\bbuy\b/.test(l)) return 'BUY';
  return 'OTHER';
}

// Strip HTML tags and collapse whitespace
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract first matching group after a label in plain text
function grabAfter(text, ...patterns) {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

function parseNotificationText(text) {
  // insider name — appears after "Name" label in section 1
  const insiderName = grabAfter(text,
    /\bName\s*[:|]\s*([A-Z][^\n|:]{2,60}?)(?:\s*[|:]|\s{2,}|\s*Position)/i,
    /1\s*\.?\s*1\s+Name\s+([^\n|]{2,60})/i,
    /\bName\s*[:|]\s*([A-Z][a-zA-Zäöåæøü\-\s]{2,50})/i,
  );

  // position/role — "Position: CEO" or "Position/status: CEO"
  const insiderRole = grabAfter(text,
    /\bPosition\s*[:|]\s*([^\n|]+?)(?=\s+(?:Issuer|LEI|ISIN|Reference|Notification type|Name)\s*[:|])/i,
    /Position\s*\/\s*status\s*[:|]\s*([^\n|]{2,80})/i,
  );

  // ISIN — e.g. "FI0009000681"
  const isin = grabAfter(text,
    /\bISIN\s*[:|]\s*([A-Z]{2}[A-Z0-9]{10})/i,
    /ISIN\s+code\s*[:|]\s*([A-Z]{2}[A-Z0-9]{10})/i,
  );

  // nature of transaction
  const nature = grabAfter(text,
    /Nature\s+of\s+(?:the\s+)?transaction\s*[:|]\s*([^\n|]+?)(?=\s+Transaction\s+details|\s+Volume|\s*$)/i,
    /Nature\s+of\s+(?:the\s+)?transaction\s*[:|]\s*([^\n|]{2,120})/i,
  );

  // date of the transaction (YYYY-MM-DD)
  const txDateRaw = grabAfter(text,
    /(?:Transaction date|Date of (?:the )?transaction)\s*[:|]\s*(\d{4}-\d{2}-\d{2})/i,
    /(?:Transaction date|Date of (?:the )?transaction)\s*[:|]\s*(\d{2}[.\/-]\d{2}[.\/-]\d{4})/i,
  );
  let txDate = null;
  if (txDateRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(txDateRaw)) {
      txDate = txDateRaw;
    } else {
      const parts = txDateRaw.split(/[.\/-]/);
      if (parts.length === 3) txDate = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
  }

  // volume / shares — "Volume: 6187" (first occurrence, before "Aggregated")
  const volRaw = grabAfter(text,
    /\bVolume\s*[:|]\s*([\d][\d\s,\.]*)/i,
  );
  let shares = null;
  if (volRaw) {
    const n = parseFloat(volRaw.replace(/[\s,]/g, ''));
    if (!isNaN(n) && n > 0) shares = Math.round(n);
  }

  // price — "Unit price: 0.00" or "Price: X"
  const priceRaw = grabAfter(text,
    /Unit\s+price\s*[:|]\s*([\d,\.]+)/i,
    /Price\s*\(s\)\s*[:|]\s*([\d,\.]+)/i,
    /\bPrice\s*[:|]\s*([\d,\.]+)/i,
  );
  let price = null;
  if (priceRaw) {
    const n = parseFloat(priceRaw.replace(/,/g, '.').replace(/\s/g, ''));
    if (!isNaN(n)) price = n;
  }

  const transactionType = mapType(nature || '');

  // Normalise "Surname, Firstname" → "Firstname Surname"
  if (insiderName && insiderName.includes(',')) {
    const parts = insiderName.split(',').map(s => s.trim());
    if (parts.length === 2 && parts[1]) insiderName = `${parts[1]} ${parts[0]}`;
  }

  return { insiderName, insiderRole, isin, txDate, shares, price, nature, transactionType };
}

function get(hostname, path, headers = {}, _redirects = 5) {
  return new Promise((resolve) => {
    const req = https.get({ hostname, path, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    }}, res => {
      // Follow redirects (Nasdaq view server redirects to language-specific URL)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects > 0) {
        const loc = res.headers.location;
        const target = loc.startsWith('http') ? new URL(loc) : new URL(`https://${hostname}${loc}`);
        res.resume();
        return resolve(get(target.hostname, target.pathname + target.search, headers, _redirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchNasdaqPage(fromDate, toDate, start) {
  const qs = new URLSearchParams({
    countResults: 'true',
    globalGroup: 'exchangeNotice',
    displayLanguage: 'en',
    timeZone: 'CET',
    dateMask: 'yyyy-MM-dd HH:mm:ss',
    limit: '200',
    start: String(start),
    dir: 'DESC',
    globalName: 'NordicAllMarkets',
    cnsCategory: "Managers' Transactions",
    market: MARKET,
    fromDate,
    toDate,
    callback: 'handleResponse',
  }).toString();

  const res = await get('api.news.eu.nasdaq.com', `/news/query.action?${qs}`);
  if (!res || res.status !== 200) return null;

  // Strip JSONP wrapper: handleResponse({...})
  let body = res.body.trim();
  if (body.startsWith('handleResponse(')) {
    body = body.slice('handleResponse('.length);
    if (body.endsWith(')')) body = body.slice(0, -1);
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function fetchNotificationDetails(messageUrl) {
  try {
    const url = new URL(messageUrl);
    const res = await get(url.hostname, url.pathname + url.search, { 'Accept': 'text/html' });
    if (!res || res.status !== 200) return null;
    return parseNotificationText(stripHtml(res.body));
  } catch {
    return null;
  }
}

// Run up to `concurrency` promises at a time
async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function scrapeFI() {
  console.log('🇫🇮  Nasdaq Helsinki — Managers\' Transactions (MAR Article 19)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to} (market: ${MARKET})…`);

  // Paginate newest-first; API ignores fromDate/toDate so we stop by item date.
  // Items also include other Nordic markets — filter by item.market === MARKET.
  const allItems = [];
  const seenIds = new Set();
  let start = 0;
  const PAGE = 200;
  const MAX_PAGES = 50;  // safety cap (~10k items max)
  let page = 0;
  outer: while (page < MAX_PAGES) {
    const data = await fetchNasdaqPage(from, to, start);
    if (!data) {
      if (start === 0) {
        console.log('  ⚠  Nasdaq Nordic API not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }
    const items = (data.results && data.results.item) || [];
    if (!items.length) break;

    let added = 0;
    let allBefore = true;
    for (const item of items) {
      const itemDate = (item.releaseTime || item.published || '').slice(0, 10);
      if (itemDate >= from) allBefore = false;

      // Skip items outside our date window or wrong market
      if (itemDate < from) continue;
      if (item.market !== MARKET) continue;

      const id = String(item.disclosureId || item.id || '');
      if (id && seenIds.has(id)) continue;
      seenIds.add(id);
      allItems.push(item);
      added++;
    }
    console.log(`  Page start=${start}: ${items.length} raw, ${added} in window+market`);

    // Stop if every item on this page is older than our window
    if (allBefore) { console.log('  All items before cutoff, stopping pagination.'); break; }
    if (items.length < PAGE) break;
    start += PAGE;
    page++;
  }

  if (!allItems.length) {
    console.log('  No manager transactions found.');
    return { saved: 0 };
  }
  console.log(`  Total from API: ${allItems.length} items. Fetching details…`);

  // Fetch full notification for each item (structured MAR data)
  const details = await pMap(allItems, async (item) => {
    if (!item.messageUrl) return null;
    return fetchNotificationDetails(item.messageUrl);
  }, CONCURRENCY);

  const seen = new Set();
  const dbRows = [];
  for (let i = 0; i < allItems.length; i++) {
    const r   = allItems[i];
    const det = details[i];

    const publishIso = (r.releaseTime || r.published || '').slice(0, 10) || from;
    const txIso      = (det && det.txDate) || publishIso;
    const fid        = `FI-${r.disclosureId || r.id || i}`;
    if (seen.has(fid)) continue; seen.add(fid);

    const isin = (det && det.isin) || null;
    const ticker = isin ? (await isinToTicker(isin, COUNTRY_CODE) || isin) : '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company:          r.company || null,
      insider_name:     det && det.insiderName ? det.insiderName : null,
      insider_role:     translateRole(det && det.insiderRole ? det.insiderRole : null),
      transaction_type: (det && det.transactionType !== 'UNKNOWN') ? det.transactionType : mapType(r.headline || ''),
      transaction_date: txIso,
      shares:           det ? det.shares : null,
      price_per_share:  det ? det.price : null,
      total_value:      (det && det.shares && det.price) ? Math.round(det.shares * det.price) : null,
      currency:         CURRENCY,
      filing_url:       r.messageUrl || `https://view.news.eu.nasdaq.com/`,
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

scrapeFI().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
