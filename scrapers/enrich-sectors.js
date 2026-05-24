'use strict';
// Nightly enrichment job: fetch Yahoo Finance sector/industry for each unique ticker
// and upsert into ticker_metadata. Skips tickers updated within 30 days.

require('dotenv').config();
const https    = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const SUFFIX = {
  SE: '.ST', GB: '.L', CH: '.SW', FR: '.PA', KR: '',  BE: '.BR',
  NO: '.OL', DE: '.DE', ES: '.MC', IT: '.MI', DK: '.CO', NL: '.AS',
  FI: '.HE', PT: '.LS', LU: '.LU',
};

function yahooSearch(yahooSymbol) {
  return new Promise(resolve => {
    const q   = encodeURIComponent(yahooSymbol);
    const req = https.get({
      hostname: 'query2.finance.yahoo.com',
      path: `/v1/finance/search?q=${q}&lang=en-US&region=US&quotesCount=1&newsCount=0`,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const d     = JSON.parse(Buffer.concat(chunks));
          const match = (d.quotes || []).find(x => x.quoteType === 'EQUITY');
          resolve(match
            ? { sector: match.sector || null, industry: match.industry || null }
            : { sector: null, industry: null });
        } catch { resolve({ sector: null, industry: null }); }
      });
    });
    req.on('error', () => resolve({ sector: null, industry: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ sector: null, industry: null }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('── Sector Enrichment ──────────────────────────────────');

  // 1. Get all unique (ticker, country_code) from insider_transactions
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('ticker, country_code')
      .not('ticker', 'is', null)
      .neq('ticker', '')
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const uniqueMap = new Map();
  for (const r of all) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, r);
  }

  // 2. Get already-fresh tickers (updated within 30 days)
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: existing } = await supabase
    .from('ticker_metadata')
    .select('ticker, country_code')
    .gte('updated_at', cutoff);

  const alreadyDone = new Set((existing || []).map(r => `${r.ticker}|${r.country_code}`));
  const toEnrich    = [...uniqueMap.values()].filter(r => !alreadyDone.has(`${r.ticker}|${r.country_code}`));

  console.log(`  ${uniqueMap.size} unique tickers, ${alreadyDone.size} already fresh, ${toEnrich.length} to enrich`);

  if (toEnrich.length === 0) {
    console.log('  ✓ All tickers up to date.');
    return;
  }

  let hits = 0, misses = 0;
  const batch = [];

  for (let i = 0; i < toEnrich.length; i++) {
    const { ticker, country_code } = toEnrich[i];
    const suffix      = SUFFIX[country_code] || '';
    const yahooSymbol = ticker + suffix;

    const { sector, industry } = await yahooSearch(yahooSymbol);

    batch.push({
      ticker,
      country_code,
      yahoo_symbol: yahooSymbol,
      sector:       sector   || null,
      industry:     industry || null,
      updated_at:   new Date().toISOString(),
    });

    if (sector) { hits++; process.stdout.write('✓'); }
    else        { misses++; process.stdout.write('·'); }

    // Flush every 50 rows
    if (batch.length >= 50) {
      await supabase.from('ticker_metadata').upsert(batch, { onConflict: 'ticker,country_code' });
      batch.length = 0;
    }

    await sleep(200);
  }

  if (batch.length > 0) {
    await supabase.from('ticker_metadata').upsert(batch, { onConflict: 'ticker,country_code' });
  }

  process.stdout.write('\n');
  console.log(`  ✓ Enriched: ${hits} with sector, ${misses} not found`);

  // 3. Print summary by sector
  const { data: summary } = await supabase
    .from('ticker_metadata')
    .select('sector')
    .not('sector', 'is', null);

  if (summary) {
    const counts = {};
    for (const r of summary) counts[r.sector] = (counts[r.sector] || 0) + 1;
    console.log('\n  Sector coverage:');
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => {
      console.log(`    ${c.toString().padStart(3)}  ${s}`);
    });
  }

  console.log('── Sector Enrichment done ─────────────────────────────');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
