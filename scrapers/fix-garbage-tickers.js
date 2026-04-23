'use strict';

/**
 * Fix old insider_transactions rows that have company-name-fragment tickers.
 *
 * Before the isinToTicker + TICKER_MAP fixes, getTicker() fell back to:
 *   company.split(/\s+/)[0].toUpperCase().slice(0, 6)
 *
 * This produced garbage like KALEON, BANCA, RENTA, ROCHE, VICAT, SHA, ATOSS etc.
 * Yahoo Finance returns 404 for all of these, causing the performance tracker
 * to loop on them forever.
 *
 * Strategy: For each country, fetch rows with short all-caps tickers (4-6 chars)
 * that have a non-zero price but return [] from Yahoo Finance. Set ticker='' so
 * the performance tracker skips them cleanly (skip.isin bucket).
 *
 * Run once: node scrapers/fix-garbage-tickers.js
 * To actually write changes, pass --write flag.
 */

const https   = require('https');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = !process.argv.includes('--write');
const supabase = createClient(
  process.env.SUPABASE_URL    || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY    || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// Known good tickers that should NOT be cleared (they work on Yahoo)
const WHITELIST = new Set([
  'SAP', 'SIE', 'ENR', 'VOW3', 'BMW', 'MBG', 'ALV', 'DBK', 'CBK', 'DTE',
  'BAS', 'BAYN', 'FRE', 'IFX', 'ADS', 'PUM', 'RHM', 'HEI', 'CON', 'SY1',
  'SRT3', 'MRK', 'MTX', 'LHA', 'VNA', 'BNR', 'BEI', 'QIA', 'ZAL', 'DWS',
  'G24', 'A1OS', 'SHA0', 'ST3', 'EOAN', 'MUV2', 'HNR1', 'AIR', 'TMV',
  // IT
  'ENEL', 'ISP', 'UCG', 'ENI', 'MB', 'LDO', 'PRY', 'MONC', 'DIA', 'REC',
  'TIT', 'TRN', 'SRG', 'IG', 'AZM', 'PIRC', 'CPR', 'AMP', 'BC', 'BAMI',
  'BPE', 'PST', 'IVG', 'CNHI', 'BZU', 'SPM', 'TEN', 'EXO', 'FBK', 'REY',
  'NEXI', 'WBD', 'MN', 'DMI', 'DAN', 'DAL', 'CATT', 'BRE', 'TNXT', 'ERG',
  'ACE', 'HER', 'IRE', 'A2A', 'IOL', 'IGD', 'SES', 'EQU', 'PIA', 'SAB',
  // FR
  'AIR', 'BNP', 'OR', 'SAN', 'TTE', 'KER', 'RI', 'MC', 'CAP', 'SGO',
  'VIV', 'ORA', 'GLE', 'ACA', 'SU', 'CS', 'EN', 'DG', 'ML', 'VIE',
  // ES
  'SAN', 'BBVA', 'ITX', 'IBE', 'REP', 'CABK', 'AMS', 'TEF', 'ELE', 'MAP',
  // NL
  'ASML', 'SHELL', 'UNA', 'INGA', 'HEIA', 'PHIA', 'NN', 'RAND', 'WKL',
  'AGN', 'ABN', 'ADYEN', 'IMCD', 'FLOW', 'LIGHT', 'SBMO', 'ASRNL', 'AALB',
  // GB
  'HSBA', 'AZN', 'ULVR', 'GSK', 'SHEL', 'BP', 'VOD', 'RIO', 'BHP', 'BTI',
  // Nordic
  'ASML', 'ERIC-B', 'VOLV-B', 'SKF-B', 'SAND', 'SEB-A', 'SHB-A', 'SWED-A',
  'DSV', 'NESTE', 'SAMPO', 'KNEBV', 'UPM', 'FORTUM', 'ELISA', 'TIE1V',
]);

// Country → Yahoo suffix for validation test
const COUNTRY_SUFFIX = {
  IT: '.MI', FR: '.PA', ES: '.MC', NL: '.AS', DE: '.DE',
  GB: '.L',  BE: '.BR', PT: '.LS', NO: '.OL', SE: '.ST',
  DK: '.CO', FI: '.HE', AT: '.VI', CH: '.SW', PL: '.WA',
};

function testYahoo(symbol) {
  return new Promise(resolve => {
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  console.log(`🧹  Garbage ticker cleanup (${DRY_RUN ? 'DRY RUN' : 'WRITE MODE'})`);

  // Garbage pattern: 4-6 ALL_CAPS letters, no dots, no digits (except exceptions)
  // These are company-name first-word fragments
  const GARBAGE_RE = /^[A-Z]{4,6}$/;
  const GARBAGE_WITH_DIGITS = /^[A-Z0-9]{4,6}$/; // catch DE WKN fragments like 000A, 0005

  // Fetch all insider_transactions with suspicious tickers
  let allRows = [];
  for (const cc of Object.keys(COUNTRY_SUFFIX)) {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from('insider_transactions')
        .select('id, ticker, company, country_code')
        .eq('country_code', cc)
        .neq('ticker', '')
        .not('ticker', 'is', null)
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
  }

  console.log(`  Loaded ${allRows.length} total rows`);

  // Filter to rows with garbage-looking tickers
  const suspicious = allRows.filter(r => {
    const t = r.ticker;
    if (WHITELIST.has(t)) return false;
    if (GARBAGE_RE.test(t) && t.length <= 6) return true;
    if (/^0[0-9A-Z]{3,5}$/.test(t)) return true; // WKN fragments: 0005, 000A
    return false;
  });

  console.log(`  Suspicious garbage tickers: ${suspicious.length}`);

  // Group by ticker+country for testing
  const groups = new Map();
  for (const r of suspicious) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }

  console.log(`  Unique ticker+country combos: ${groups.size}`);

  const toFix = [];

  for (const [key, ids] of groups) {
    const [ticker, cc] = key.split('|');
    const suffix = COUNTRY_SUFFIX[cc] || '';
    const symbol = ticker + suffix;

    const works = await testYahoo(symbol);
    await new Promise(r => setTimeout(r, 200));

    if (!works) {
      console.log(`  ✗ ${symbol} (${ids.length} rows) → clearing`);
      toFix.push(...ids);
    } else {
      console.log(`  ✓ ${symbol} (${ids.length} rows) → keeping`);
    }
  }

  console.log(`\n  Will clear ${toFix.length} rows`);

  if (DRY_RUN) {
    console.log('  Dry run — pass --write to apply');
    return;
  }

  // Clear tickers in batches
  for (let i = 0; i < toFix.length; i += 100) {
    const batch = toFix.slice(i, i + 100);
    const { error } = await supabase
      .from('insider_transactions')
      .update({ ticker: '' })
      .in('id', batch);
    if (error) console.error(`  ❌ batch ${i}: ${error.message}`);
  }

  console.log(`  ✅ Cleared ${toFix.length} garbage-ticker rows`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
