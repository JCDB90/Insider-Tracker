/**
 * Sweden (SE) — Insider Transactions Scraper
 *
 * Source: Finansinspektionen (FI) — Insynsregistret
 * URL: https://marknadssok.fi.se/publiceringsklient/en/Search?SearchFunctionType=Insyn
 *
 * Pagination: 10 rows/page, GET request, date-filtered.
 * Fields: company, insider, role, Acquisition(BUY)/Disposal(SELL), shares, price, SEK.
 */
'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }          = require('./lib/translate');

const COUNTRY_CODE   = 'SE';
const SOURCE         = 'Finansinspektionen Sweden';
const RETENTION_DAYS = 14;
const DELAY_MS       = 600;
const BASE           = 'https://marknadssok.fi.se/publiceringsklient/en/Search';
const HEADERS        = {
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
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function parseNum(s) {
  if (!s || s.trim() === '-') return null;
  const v = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return isNaN(v) ? null : v;
}
function mapType(s) {
  if (!s) return 'UNKNOWN';
  const l = s.toLowerCase();
  if (l.includes('acqui') || l.includes('subscript') || l.includes('grant')) return 'BUY';
  if (l.includes('dispos') || l.includes('sale') || l.includes('redem'))      return 'SELL';
  return 'OTHER';
}

const TICKERS = {
  'evolution': 'EVO', 'hexagon': 'HEXA-B', 'ericsson': 'ERIC-B', 'volvo': 'VOLV-B',
  'abb': 'ABB', 'atlas copco': 'ATCO-A', 'investor': 'INVE-B', 'essity': 'ESSITY-B',
  'sandvik': 'SAND', 'handelsbanken': 'SHB-A', 'swedbank': 'SWED-A', 'seb': 'SEB-A',
  'nordea': 'NDA-SE', 'alfa laval': 'ALFA', 'nibe': 'NIBE-B', 'sinch': 'SINCH',
  'tele2': 'TEL2-B', 'telia': 'TELIA', 'boliden': 'BOL', 'h&m': 'HM-B',
  'hennes & mauritz': 'HM-B', 'autoliv': 'ALIV-SDB', 'elekta': 'EKTA-B',
  'getinge': 'GETI-B', 'ssab': 'SSAB-A', 'husqvarna': 'HUSQ-B', 'skanska': 'SKA-B',
};
function getTicker(n) {
  if (!n) return null;
  const l = n.toLowerCase();
  for (const [k, v] of Object.entries(TICKERS)) if (l.includes(k)) return v;
  return n.split(/\s+/)[0].toUpperCase().slice(0, 6) || null;
}

async function fetchPage(from, to, page) {
  const url = `${BASE}?SearchFunctionType=Insyn&Utgivare=&PersonILedandeStallning=` +
    `&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}` +
    `&Volym=&Instrument.Typ=&IsinKod=&Transaktionstyp=&Page=${page}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const rows = [];
  $('tbody tr').each((_, tr) => {
    const c = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
    if (c.length < 13) return;
    rows.push({ company: c[1], insider: c[2], position: c[3], nature: c[5],
                isin: c[8], txDateStr: c[9], volume: c[10], price: c[12], currency: c[13] || 'SEK' });
  });
  return rows;
}

async function scrapeSE() {
  console.log('🇸🇪  Finansinspektionen Sweden — Insynsregistret');
  const t0 = Date.now();
  const co = cutoff();
  const to = isoDate(new Date()), from = isoDate(co);

  console.log(`  Fetching ${from} → ${to}…`);
  const allRaw = [];
  let page = 1, emptyRun = 0;

  while (emptyRun < 2 && page <= 500) {
    let rows;
    try { rows = await fetchPage(from, to, page); }
    catch (err) { console.warn(`  ⚠  p${page}: ${err.message}`); break; }
    if (rows.length === 0) { emptyRun++; } else { emptyRun = 0; allRaw.push(...rows); }
    if (rows.length < 10) break;
    page++;
    if (page > 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`  ${allRaw.length} rows from ${page} page(s)`);
  if (!allRaw.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen = new Set();
  const dbRows = [];
  for (const r of allRaw) {
    const txDate = parseSEDate(r.txDateStr);
    if (!txDate || txDate < co) continue;
    const txIso = isoDate(txDate);
    const shares = parseNum(r.volume), price = parseNum(r.price);
    const total = (shares && price) ? Math.round(shares * price) : null;
    const slug = (r.insider || '').replace(/\W/g, '').slice(0, 10).toLowerCase();
    const fid  = `SE-${r.isin || 'X'}-${txIso}-${slug}-${Math.round(shares||0)}`;
    if (seen.has(fid)) continue;
    seen.add(fid);
    dbRows.push({
      filing_id: fid, country_code: COUNTRY_CODE,
      ticker: getTicker(r.company), company: r.company || null,
      insider_name: r.insider || null, insider_role: translateRole(r.position) || null,
      transaction_type: mapType(r.nature), transaction_date: txIso,
      shares: shares !== null ? Math.round(shares) : null,
      price_per_share: price, total_value: total, currency: r.currency,
      filing_url: `${BASE}?SearchFunctionType=Insyn&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}`,
      source: SOURCE,
    });
  }

  console.log(`  ${dbRows.length} unique rows`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.company}/${r.transaction_type}`).join(', ')}`);
  return { saved: dbRows.length };
}

scrapeSE().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
