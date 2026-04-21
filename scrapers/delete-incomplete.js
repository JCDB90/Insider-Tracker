#!/usr/bin/env node
/**
 * One-shot: delete all insider_transactions rows that are missing
 * insider_name, shares, or price_per_share.
 *
 * Usage: node scrapers/delete-incomplete.js
 */

'use strict';

const { supabase } = require('./lib/db');

async function main() {
  console.log('Querying incomplete rows…');

  // Fetch IDs of incomplete rows so we can show exactly what gets deleted
  const PAGE = 1000;
  const toDelete = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, company, insider_name, shares, price_per_share, transaction_date, country_code')
      .or('insider_name.is.null,insider_name.eq.,shares.is.null,shares.eq.0,price_per_share.is.null,price_per_share.eq.0')
      .range(from, from + PAGE - 1);

    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    toDelete.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (toDelete.length === 0) {
    console.log('✅ No incomplete rows found — database is clean.');
    return;
  }

  console.log(`\nFound ${toDelete.length} incomplete rows:\n`);
  for (const r of toDelete) {
    console.log(`  [${r.country_code}] ${r.company || '?'} | ${r.transaction_date || '?'} | name=${r.insider_name ?? 'NULL'} shares=${r.shares ?? 'NULL'} price=${r.price_per_share ?? 'NULL'}`);
  }

  console.log(`\nDeleting ${toDelete.length} rows…`);
  const ids = toDelete.map(r => r.id);

  // Delete in batches of 500 (URL length safety)
  const BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { error } = await supabase
      .from('insider_transactions')
      .delete()
      .in('id', batch);
    if (error) {
      console.error(`  ❌ Delete error (batch ${i}–${i + BATCH}):`, error.message);
    } else {
      deleted += batch.length;
      console.log(`  Deleted batch ${Math.floor(i / BATCH) + 1}: ${batch.length} rows`);
    }
  }

  console.log(`\n✅ Done — deleted ${deleted} incomplete rows.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
