/**
 * KR — Insider Transactions Scraper
 *
 * Source: DART (Data Analysis, Retrieval and Transfer) — Korea Financial Supervisory Service
 * API: https://opendart.fss.or.kr/api/list.json
 *      https://opendart.fss.or.kr/api/innerTradeList.json
 *
 * Requires a free API key — register at https://opendart.fss.or.kr/intro/main.do
 * Set the key as DART_API_KEY environment variable.
 *
 * Approach:
 *   1. Fetch the disclosure list for report type "officers' share transactions" (pblntf_detail_ty=J001).
 *   2. For each disclosure, fetch details to extract transaction type, shares, and price.
 *   3. Use innerTradeList for position holder transactions (PDMR equivalents).
 *
 * Columns (innerTradeList):
 *   rcept_no, corp_cls, corp_code, corp_name, reprt_code, bsns_year,
 *   docm_no, stock_knd, stkqy_change_knd, stkqy_change_cnt, at_pric,
 *   hold_stk_cnt, hold_stk_ratio, reprt_dt
 */
'use strict';

const fetch = require('node-fetch');
const { saveInsiderTransactions } = require('./lib/db');

const COUNTRY_CODE   = 'KR';
const SOURCE         = 'DART South Korea';
const RETENTION_DAYS = 14;
const CURRENCY       = 'KRW';
const DELAY_MS       = 300;
const API_BASE       = 'https://opendart.fss.or.kr/api';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dartDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function parseNum(s) {
  if (!s || s === '-') return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(v) ? null : v;
}
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  // Korean: 취득=acquisition(BUY), 처분=disposal(SELL)
  if (l.includes('취득') || l.includes('acquisition') || l.includes('buy') || l.includes('grant')) return 'BUY';
  if (l.includes('처분') || l.includes('disposal') || l.includes('sell')) return 'SELL';
  return 'OTHER';
}

async function fetchInnerTradeList(apiKey, bgn, end, page) {
  const url = `${API_BASE}/innerTradeList.json?crtfc_key=${apiKey}&bgn_de=${bgn}&end_de=${end}&page_no=${page}&page_count=100`;
  const res = await fetch(url, { headers: { 'User-Agent': 'InsiderTracker/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function scrapeKR() {
  console.log('🇰🇷  DART South Korea');
  const t0 = Date.now();

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.log('  ⚠  DART_API_KEY not set — register free at https://opendart.fss.or.kr/intro/main.do');
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  const co = cutoff();
  const bgn = dartDate(co);
  const end = dartDate(new Date());
  console.log(`  Fetching ${bgn} → ${end}…`);

  const allRaw = [];
  let page = 1;

  while (true) {
    let data;
    try { data = await fetchInnerTradeList(apiKey, bgn, end, page); }
    catch (err) { console.warn(`  ⚠  p${page}: ${err.message}`); break; }

    if (data.status !== '000') {
      console.warn(`  ⚠  DART API error: ${data.status} — ${data.message}`);
      break;
    }

    const items = data.list || [];
    allRaw.push(...items);
    console.log(`  p${page}: ${items.length} items (total ${allRaw.length})`);

    const total = parseInt(data.total_count || '0', 10);
    if (allRaw.length >= total || items.length === 0) break;
    page++;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`  ${allRaw.length} raw rows`);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  const todayIso = isoDate(new Date());

  for (const r of allRaw) {
    // reprt_dt = 보고일 (report date) in YYYYMMDD format
    const txRaw = r.reprt_dt || r.bsns_year || '';
    const txIso = txRaw.length === 8
      ? `${txRaw.slice(0,4)}-${txRaw.slice(4,6)}-${txRaw.slice(6,8)}`
      : todayIso;
    const txDate = new Date(txIso);
    if (txDate < co) continue;

    const shares  = parseNum(r.stkqy_change_cnt);
    const price   = parseNum(r.at_pric);
    const total   = (shares && price) ? Math.round(Math.abs(shares) * price) : null;
    const slug    = (r.corp_code || '').slice(0, 10).toLowerCase();
    const fid     = `KR-${r.corp_code || 'X'}-${txIso}-${slug}-${Math.round(Math.abs(shares||0))}`;

    if (seen.has(fid)) continue;
    seen.add(fid);

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           r.corp_code || null,
      company:          r.corp_name || null,
      insider_name:     null,         // not in list endpoint
      insider_role:     null,
      transaction_type: mapType(r.stkqy_change_knd),
      transaction_date: txIso,
      shares:           shares !== null ? Math.round(Math.abs(shares)) : null,
      price_per_share:  price,
      total_value:      total,
      currency:         CURRENCY,
      filing_url:       `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no || ''}`,
      source:           SOURCE,
    });
  }

  console.log(`  ${dbRows.length} unique rows`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeKR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
