'use strict';

/**
 * One-time repair: fix Spain 'Not disclosed' rows where via_entity is actually
 * a person name that was misclassified as corporate due to accented-letter
 * false word-boundaries (e.g. "DUEÑAS" triggering \bAS suffix check).
 *
 * For rows where via_entity is a person name: move via_entity → insider_name.
 * For rows where via_entity is genuinely corporate: leave unchanged.
 */

const { createClient } = require('@supabase/supabase-js');
const { looksLikeCorp } = require('./lib/entityUtils');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

async function main() {
  console.log('Querying ES Not disclosed rows…');

  // Paginate in case there are more than 1000
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, company, via_entity, insider_name')
      .eq('country_code', 'ES')
      .eq('insider_name', 'Not disclosed')
      .not('via_entity', 'is', null)
      .range(from, from + 999);
    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`Found ${all.length} ES 'Not disclosed' rows with via_entity`);

  const toFix = all.filter(r => !looksLikeCorp(r.via_entity));
  const keepCorp = all.filter(r => looksLikeCorp(r.via_entity));

  console.log(`  Person names (to fix):  ${toFix.length}`);
  console.log(`  Corporate (keep as-is): ${keepCorp.length}`);

  if (toFix.length === 0) {
    console.log('Nothing to fix.');
    return;
  }

  console.log('\nSample fixes:');
  for (const r of toFix.slice(0, 5)) {
    console.log(`  ${r.company} | "${r.via_entity}" → insider_name`);
  }
  if (keepCorp.length > 0) {
    console.log('\nSample kept corporate:');
    for (const r of keepCorp.slice(0, 3)) {
      console.log(`  ${r.company} | via: "${r.via_entity}" (corp)`);
    }
  }

  // Update in batches of 50
  let updated = 0;
  for (let i = 0; i < toFix.length; i += 50) {
    const batch = toFix.slice(i, i + 50);
    const ids = batch.map(r => r.id);

    // Build a map of id → via_entity for the update
    for (const row of batch) {
      const { error } = await supabase
        .from('insider_transactions')
        .update({ insider_name: row.via_entity, via_entity: null })
        .eq('id', row.id);
      if (error) {
        console.error(`  ❌ Failed to update id=${row.id}: ${error.message}`);
      } else {
        updated++;
      }
    }
    if (i % 100 === 0 && i > 0) console.log(`  Updated ${updated}/${toFix.length}…`);
  }

  console.log(`\n✅ Fixed ${updated} rows — moved via_entity → insider_name`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
