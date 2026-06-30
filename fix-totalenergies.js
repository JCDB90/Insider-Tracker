'use strict';
/**
 * Fix TotalEnergies SE data issues:
 * 1. Set ticker='TTE' on all TotalEnergies transactions
 * 2. Add isin_ticker_cache entry: FR0014000MR3|FR → TTE
 * 3. Insert ticker_metadata row for TTE
 * 4. Delete duplicate null-price RSU rows (keep price=0 is_unusual_price=true versions)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run() {

  // ── 1. Fix ticker on all TotalEnergies transactions ──────────────────────
  console.log('\n1. Fixing ticker for all TOTALENERGIES SE transactions...');
  const { data: rows } = await sb.from('insider_transactions')
    .select('id')
    .ilike('company', '%totalenergies%')
    .not('ticker', 'eq', 'TTE');

  if (!rows?.length) {
    console.log('   All already set to TTE — nothing to do.');
  } else {
    const ids = rows.map(r => r.id);
    console.log(`   Updating ${ids.length} rows to ticker='TTE'...`);
    // Supabase SDK doesn't support bulk update by id list directly — batch in chunks
    const CHUNK = 200;
    let updated = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { error } = await sb.from('insider_transactions')
        .update({ ticker: 'TTE' })
        .in('id', chunk);
      if (error) { console.error('   ❌ Ticker update error:', error.message); process.exit(1); }
      updated += chunk.length;
    }
    console.log(`   ✅ Updated ${updated} rows → ticker='TTE'`);
  }

  // ── 2. Fix isin_ticker_cache ──────────────────────────────────────────────
  console.log('\n2. Fixing isin_ticker_cache for FR0014000MR3...');
  // Remove wrong LU entry, add correct FR entry
  const { error: delErr } = await sb.from('isin_ticker_cache')
    .delete()
    .eq('isin', 'FR0014000MR3')
    .eq('country_code', 'LU');
  if (delErr) console.warn('   ⚠ Could not delete LU entry:', delErr.message);
  else console.log('   Removed wrong FR0014000MR3|LU → ERF entry');

  const { error: cacheErr } = await sb.from('isin_ticker_cache')
    .upsert({ isin: 'FR0014000MR3', country_code: 'FR', ticker: 'TTE', resolved_at: new Date().toISOString() },
            { onConflict: 'isin,country_code', ignoreDuplicates: false });
  if (cacheErr) console.error('   ❌ Cache upsert error:', cacheErr.message);
  else console.log('   ✅ Upserted FR0014000MR3|FR → TTE');

  // Also add empty-country fallback key used by some callers
  const { error: cacheErr2 } = await sb.from('isin_ticker_cache')
    .upsert({ isin: 'FR0014000MR3', country_code: '', ticker: 'TTE', resolved_at: new Date().toISOString() },
            { onConflict: 'isin,country_code', ignoreDuplicates: false });
  if (cacheErr2) console.warn('   ⚠ Fallback cache entry skipped:', cacheErr2.message);
  else console.log('   ✅ Upserted FR0014000MR3| → TTE (fallback)');

  // ── 3. Insert ticker_metadata for TTE ────────────────────────────────────
  console.log('\n3. Inserting ticker_metadata for TTE...');
  const { error: metaErr } = await sb.from('ticker_metadata')
    .upsert({
      ticker:       'TTE',
      country_code: 'FR',
      yahoo_symbol: 'TTE.PA',
      sector:       'Energy',
      industry:     'Oil & Gas Integrated',
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'ticker', ignoreDuplicates: false });
  if (metaErr) console.error('   ❌ ticker_metadata error:', metaErr.message);
  else console.log('   ✅ Upserted TTE → TTE.PA (Energy / Oil & Gas Integrated)');

  // ── 4. Delete duplicate null-price RSU rows ───────────────────────────────
  // For each (insider, shares, date) that has BOTH a price=0 row AND a price=null row,
  // delete the price=null version (less informative, missing is_unusual_price flag).
  console.log('\n4. Cleaning up duplicate null-price RSU rows...');

  // Get all null-price TotalEnergies rows
  const { data: nullRows } = await sb.from('insider_transactions')
    .select('id, insider_name, shares, price_per_share, transaction_date, filing_url')
    .ilike('company', '%totalenergies%')
    .is('price_per_share', null);

  if (!nullRows?.length) {
    console.log('   No null-price rows found.');
  } else {
    // Get all price=0 rows to identify which null rows are true duplicates
    const { data: zeroRows } = await sb.from('insider_transactions')
      .select('insider_name, shares, transaction_date, filing_url')
      .ilike('company', '%totalenergies%')
      .eq('price_per_share', 0);

    const zeroKeys = new Set(
      (zeroRows || []).map(r => `${r.insider_name}|${r.shares}|${r.transaction_date}|${r.filing_url}`)
    );

    const toDelete = nullRows.filter(r =>
      zeroKeys.has(`${r.insider_name}|${r.shares}|${r.transaction_date}|${r.filing_url}`)
    );

    if (!toDelete.length) {
      console.log('   No duplicate null-price rows to delete.');
    } else {
      console.log(`   Found ${toDelete.length} duplicate null-price rows to delete:`);
      toDelete.forEach(r => console.log(`     - ${r.insider_name} | ${r.shares} shares | ${r.transaction_date}`));

      const deleteIds = toDelete.map(r => r.id);
      const { error: delRowsErr } = await sb.from('insider_transactions')
        .delete()
        .in('id', deleteIds);
      if (delRowsErr) console.error('   ❌ Delete error:', delRowsErr.message);
      else console.log(`   ✅ Deleted ${deleteIds.length} duplicate null-price rows`);
    }
  }

  // ── 5. Verify final state ─────────────────────────────────────────────────
  console.log('\n5. Final verification...');
  const { data: final, count } = await sb.from('insider_transactions')
    .select('ticker, price_per_share, is_unusual_price, transaction_date', { count: 'exact' })
    .ilike('company', '%totalenergies%');

  const tickers    = [...new Set(final.map(r => r.ticker))];
  const nullPrices = final.filter(r => r.price_per_share === null).length;
  const zeroPrices = final.filter(r => r.price_per_share === 0).length;
  const rsuRows    = final.filter(r => r.is_unusual_price).length;

  console.log(`   Total rows: ${count}`);
  console.log(`   Distinct tickers: ${JSON.stringify(tickers)}`);
  console.log(`   Null price rows: ${nullPrices}`);
  console.log(`   Zero price (RSU) rows: ${zeroPrices} (is_unusual_price=true: ${rsuRows})`);

  const { data: meta } = await sb.from('ticker_metadata').select('*').eq('ticker', 'TTE');
  console.log(`   ticker_metadata: ${JSON.stringify(meta?.[0])}`);

  console.log('\n✅ All fixes applied.');
}

run().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
