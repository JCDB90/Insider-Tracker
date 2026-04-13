/**
 * AU — Insider Transactions Scraper
 *
 * Source: ASX (Australian Securities Exchange) — Market Announcements Platform
 * API: https://www.asx.com.au/asx/1/announcement/list
 *
 * Uses JSONP endpoint. Key: end_date/start_date must be Unix ms timestamps.
 * announcement_classifications=3Y → Appendix 3Y = "Change in Director's Interest Notice"
 * (directors must file within 3 business days of a share trade).
 *
 * Response fields (announcement_data array):
 *   id, document_release_date, document_date, url, header,
 *   market_sensitive, number_of_pages, size,
 *   issuer_code, issuer_short_name, issuer_full_name, issuerId
 *
 * Note: Price/shares data is only in the PDF — we save filing metadata.
 * Transaction type inferred from headline where possible (UNKNOWN otherwise).
 */
'use strict';

const https   = require('https');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'AU';
const SOURCE         = 'ASX Australia';
const RETENTION_DAYS = 14;
const CURRENCY       = 'AUD';
const PAGE_SIZE      = 5000;  // max to avoid 2000-cap; use 2-day windows instead
const WINDOW_MS      = 1 * 24 * 60 * 60 * 1000;  // 1-day windows (ASX has ~2000 limit per request)
const BASE_URL       = 'https://www.asx.com.au';
const JSONP_CB       = 'loadAnnouncementsPagination';
const DELAY_MS       = 600;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function fetchRange(startMs, endMs) {
  return new Promise((resolve, reject) => {
    const qs = [
      `end_date=${endMs}`,
      `start_date=${startMs}`,
      `announcement_classifications=3Y`,
      `page_size=${PAGE_SIZE}`,
      `callback=${JSONP_CB}`,
    ].join('&');
    const options = {
      hostname: 'www.asx.com.au',
      path: `/asx/1/announcement/list?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    `${BASE_URL}/markets/trade-our-cash-market/announcements`,
        'Accept':     'text/javascript,*/*',
      },
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          // Strip JSONP wrapper: loadAnnouncementsPagination({...}); → parse inner JSON
          const prefix = `${JSONP_CB}(`;
          const inner  = data.slice(prefix.length).replace(/\);\s*$/, '');
          resolve(JSON.parse(inner));
        } catch (e) {
          reject(new Error(`JSONP parse error: ${e.message} | data[:100]: ${data.slice(0,100)}`));
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function scrapeAU() {
  console.log("🇦🇺  ASX Australia — Appendix 3Y (Change in Director's Interest)");
  const t0 = Date.now();
  const co = cutoff();
  const now = new Date();

  const startMs = co.getTime();
  const endMs   = now.getTime();
  console.log(`  Fetching ${isoDate(co)} → ${isoDate(now)} in 1-day windows…`);

  const allRaw = [];
  let windowEnd = endMs;

  while (windowEnd > startMs) {
    const windowStart = Math.max(startMs, windowEnd - WINDOW_MS);
    let data;
    try { data = await fetchRange(windowStart, windowEnd); }
    catch (err) { console.warn(`  ⚠  window ${isoDate(new Date(windowStart))}: ${err.message}`); }

    if (data) {
      const items = data.announcement_data || [];
      allRaw.push(...items);
      if (items.length > 0) {
        console.log(`  ${isoDate(new Date(windowStart))}→${isoDate(new Date(windowEnd))}: ${items.length} items`);
      }
    }
    windowEnd = windowStart;
    if (windowEnd > startMs) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`  ${allRaw.length} raw announcements`);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];

  for (const r of allRaw) {
    const txRaw  = r.document_date || r.document_release_date || '';
    const txDate = txRaw ? new Date(txRaw) : null;
    if (!txDate || txDate < co) continue;
    const txIso = isoDate(txDate);

    const fid = `AU-${r.id || 'X'}-${r.issuer_code || 'X'}-${txIso}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    // Infer type from headline where possible
    const h = (r.header || '').toLowerCase();
    let txType = 'UNKNOWN';
    if (
      h.includes('becoming') || h.includes('acquiring') || h.includes('acquisition') ||
      h.includes('purchase') || h.includes('on-market buy') || h.includes('exercise') ||
      h.includes('initial director') || h.includes('initial substantial')
    ) txType = 'BUY';
    else if (
      h.includes('ceasing') || h.includes('disposal') || h.includes('sell') ||
      h.includes('final director') || h.includes('final substantial') || h.includes('sold')
    ) txType = 'SELL';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.issuer_code || null,
      company:          r.issuer_full_name || r.issuer_short_name || null,
      insider_name:     null,
      insider_role:     null,
      transaction_type: txType,
      transaction_date: txIso,
      shares:           null,
      price_per_share:  null,
      total_value:      null,
      currency:         CURRENCY,
      filing_url:       r.url || `${BASE_URL}${r.relative_url || ''}`,
      source:           SOURCE,
    });
  }

  console.log(`  ${dbRows.length} unique rows`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  const unk   = dbRows.filter(r => r.transaction_type === 'UNKNOWN').length;
  console.log(`  ${dbRows.length} rows: ${buys} BUY, ${sells} SELL, ${unk} UNKNOWN (will be dropped)`);
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${buys + sells} saved (BUY/SELL only)`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.ticker}/${r.company}`).join(', ')}`);
  return { saved: dbRows.length };
}

scrapeAU().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
