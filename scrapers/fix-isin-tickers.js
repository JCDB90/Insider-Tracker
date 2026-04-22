'use strict';

/**
 * One-time repair: replaces ISIN-format tickers in insider_transactions
 * with real exchange ticker symbols via Yahoo Finance search.
 *
 * Run once on the VPS after deploying the scraper fixes:
 *   node scrapers/fix-isin-tickers.js
 */

const { createClient } = require('@supabase/supabase-js');
const { isinToTicker } = require('./lib/isinToTicker');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

async function main() {
  console.log('🔧  ISIN→Ticker repair script');
  const t0 = Date.now();

  // Fetch all rows — filter ISIN-format tickers client-side
  const isinRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, ticker, country_code')
      .not('ticker', 'is', null)
      .order('transaction_date', { ascending: false })
      .range(from, from + 999);
    if (error) { console.error('❌ Query:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    isinRows.push(...data.filter(r => r.ticker && ISIN_RE.test(r.ticker)));
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`  Found ${isinRows.length} rows with ISIN-format tickers`);
  if (!isinRows.length) { console.log('  Nothing to fix.'); return; }

  let fixed = 0, notFound = 0, errors = 0;

  for (const row of isinRows) {
    try {
      const newTicker = await isinToTicker(row.ticker, row.country_code);
      if (!newTicker || newTicker === row.ticker) { notFound++; continue; }

      const { error } = await supabase
        .from('insider_transactions')
        .update({ ticker: newTicker })
        .eq('id', row.id);

      if (error) { errors++; }
      else {
        fixed++;
        if (fixed % 25 === 0) console.log(`  Progress: ${fixed} fixed…`);
      }
    } catch { errors++; }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — fixed: ${fixed} | not found: ${notFound} | errors: ${errors}`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
