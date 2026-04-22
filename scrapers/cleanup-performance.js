'use strict';

/**
 * Data quality cleanup for insider_performance and insider_transactions.
 *
 * 1. Delete "Not disclosed" rows from insider_performance
 * 2. Delete "them." (parse artifact) from both tables
 * 3. Delete QS* fake-ISIN rows from insider_transactions
 * 4. Delete CH rows from insider_performance (no individual names → skews avg returns)
 * 5. Move corporate entity names to via_entity, null out insider_name
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// Corporate suffixes / patterns that indicate an entity, not a person
const CORP_PATTERNS = [
  /\bS\.?A\.?\b/i,
  /\bN\.?V\.?\b/i,
  /\bB\.?V\.?\b/i,
  /\bLtd\.?\b/i,
  /\bLLC\b/i,
  /\bInc\.?\b/i,
  /\bCorp\.?\b/i,
  /\bplc\.?\b/i,
  /\bGmbH\b/i,
  /\bS\.?A\.?R\.?L\.?\b/i,
  /\bS\.?C\.?A\.?\b/i,
  /\bS\.?à\.?\s*r\.?l\.?\b/i,
  /\bSoci[eé]t[eé]\b/i,
  /\bsoci[eé]t[eé]\b/,
  /\bHolding\b/i,
  /\bParticipations?\b/i,
  /\bInvest(?:ment)?\b/i,
  /\bCapital\b/i,
  /\bFund\b/i,
  /\bTrust\b/i,
  /\bA\.?S\.?\b/,         // Nordic: AS, ASA
  /\bA\.?S\.?A\.?\b/,
  /\bA\.?B\.?\b/,         // Swedish: AB
  /\bO\.?y\.?\b/i,        // Finnish: Oy
  /\bK\.?e\.?r\.?\b/i,
  /\bCompagnie\b/i,
  /\bGroupe\b/i,
  /\bFamil(?:y|le)\b/i,
  /\bAssociat/i,
  /\bFoundation\b/i,
  /\bFondation\b/i,
];

function looksLikeCorp(name) {
  if (!name) return false;
  return CORP_PATTERNS.some(re => re.test(name));
}

async function del(table, filters, desc) {
  let q = supabase.from(table).delete();
  for (const f of filters) q = f(q);
  const { error, count } = await q.select('id');
  if (error) {
    console.error(`  ❌ ${desc}: ${error.message}`);
    return 0;
  }
  const n = Array.isArray(count) ? count.length : (count ?? '?');
  console.log(`  ✓ ${desc}: removed ${n} rows`);
  return n;
}

async function main() {
  console.log('🧹  Performance data quality cleanup\n');

  // ── 1. Delete "Not disclosed" from insider_performance ───────────────────
  await del('insider_performance',
    [q => q.eq('insider_name', 'Not disclosed')],
    'Remove "Not disclosed" from insider_performance'
  );

  // ── 2. Delete "them." parse artifact ─────────────────────────────────────
  await del('insider_performance',
    [q => q.ilike('insider_name', '%them.%')],
    'Remove "them." artifact from insider_performance'
  );
  await del('insider_transactions',
    [q => q.ilike('insider_name', '%them.%')],
    'Remove "them." artifact from insider_transactions'
  );

  // ── 3. Delete QS* fake-ISIN rows ─────────────────────────────────────────
  await del('insider_transactions',
    [q => q.like('ticker', 'QS%')],
    'Remove QS* fake-ISIN rows from insider_transactions'
  );
  await del('insider_performance',
    [q => q.like('ticker', 'QS%')],
    'Remove QS* fake-ISIN rows from insider_performance'
  );

  // ── 4. Delete CH rows from insider_performance ────────────────────────────
  // Switzerland stores "Not disclosed" for all names → skews avg return stats
  await del('insider_performance',
    [q => q.eq('country_code', 'CH')],
    'Remove CH rows from insider_performance (no individual names)'
  );

  // ── 5. Move corporate entity names → via_entity, null insider_name ────────
  console.log('\n  Scanning for corporate entity names…');

  // Fetch all distinct insider_names from insider_performance
  const perfRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('insider_performance')
      .select('id, insider_name, via_entity')
      .not('insider_name', 'is', null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    perfRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const corpPerfRows = perfRows.filter(r => looksLikeCorp(r.insider_name));
  console.log(`  Found ${corpPerfRows.length} insider_performance rows with corporate names`);

  let perfMoved = 0;
  for (const r of corpPerfRows) {
    const { error } = await supabase
      .from('insider_performance')
      .update({ via_entity: r.insider_name, insider_name: null })
      .eq('id', r.id);
    if (!error) perfMoved++;
  }
  console.log(`  ✓ Moved ${perfMoved} corporate names → via_entity in insider_performance`);

  // Also update insider_transactions
  const txRows = [];
  from = 0;
  while (true) {
    const { data } = await supabase
      .from('insider_transactions')
      .select('id, insider_name')
      .not('insider_name', 'is', null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    txRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const corpTxRows = txRows.filter(r => looksLikeCorp(r.insider_name));
  console.log(`  Found ${corpTxRows.length} insider_transactions rows with corporate names`);

  let txMoved = 0;
  for (const r of corpTxRows) {
    const { error } = await supabase
      .from('insider_transactions')
      .update({ via_entity: r.insider_name, insider_name: null })
      .eq('id', r.id);
    if (!error) txMoved++;
  }
  console.log(`  ✓ Moved ${txMoved} corporate names → via_entity in insider_transactions`);

  console.log('\n  ✅ Cleanup complete.');
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
