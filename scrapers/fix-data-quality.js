'use strict';

/**
 * One-shot data quality cleanup for insider_transactions table.
 *
 * Run with:  node scrapers/fix-data-quality.js
 *
 * What it does:
 *   1. Delete NL rows with price=0 or NULL (RSU vestings without market price)
 *   2. Fix Germany OTHER rows: re-map transaction_type for known BaFin types
 *   3. Fix France insider_name: strip role keywords for existing rows
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_KEY env var required (service role key)');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── 1. Delete NL price=0 rows ────────────────────────────────────────────────

async function deleteNlZeroPriceRows() {
  console.log('\n── Step 1: Delete NL rows with price=0 or NULL ──────────────────');

  // Count first
  const { count, error: ce } = await db
    .from('insider_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('country_code', 'NL')
    .or('price_per_share.is.null,price_per_share.eq.0');

  if (ce) { console.error('  Count error:', ce.message); return; }
  console.log(`  Found ${count} NL rows with price=0 or NULL`);

  if (count === 0) { console.log('  Nothing to delete.'); return; }

  const { error } = await db
    .from('insider_transactions')
    .delete()
    .eq('country_code', 'NL')
    .or('price_per_share.is.null,price_per_share.eq.0');

  if (error) { console.error('  ❌ Delete error:', error.message); return; }
  console.log(`  ✅ Deleted ${count} rows`);
}

// ─── 2. Fix Germany OTHER transaction types ───────────────────────────────────

async function fixGermanyOtherTypes() {
  console.log('\n── Step 2: Fix Germany OTHER transaction types ──────────────────');

  // BaFin stores type description in filing notes, but we don't have it in the DB.
  // We can't re-map without re-fetching. Instead, delete DE OTHER rows so they get
  // re-fetched with correct types on next scraper run.
  const { count, error: ce } = await db
    .from('insider_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('country_code', 'DE')
    .eq('transaction_type', 'OTHER');

  if (ce) { console.error('  Count error:', ce.message); return; }
  console.log(`  Found ${count} DE OTHER rows`);

  if (count === 0) { console.log('  Nothing to delete.'); return; }

  const { error } = await db
    .from('insider_transactions')
    .delete()
    .eq('country_code', 'DE')
    .eq('transaction_type', 'OTHER');

  if (error) { console.error('  ❌ Delete error:', error.message); return; }
  console.log(`  ✅ Deleted ${count} DE OTHER rows — will re-scrape with correct type`);
}

// ─── 3. Fix France role-in-name ───────────────────────────────────────────────

const ROLE_KW_RE = /\s*,?\s+(?:DIRECTEUR|DIRECTRICE|PRÉSIDENT|PRÉSIDENTE|PDG|P-DG|CEO|CFO|COO|ADMINISTRATEUR|ADMINISTRATRICE|MEMBRE DU CONSEIL|VICE[- ]?PRÉSIDENT|SECRÉTAIRE GÉNÉRAL)\b.*/i;

async function fixFranceRoleInName() {
  console.log('\n── Step 3: Fix France role contaminating insider_name ───────────');

  // Fetch all FR rows
  const { data, error } = await db
    .from('insider_transactions')
    .select('id, insider_name, insider_role')
    .eq('country_code', 'FR');

  if (error) { console.error('  Fetch error:', error.message); return; }
  console.log(`  Fetched ${data.length} FR rows`);

  const toFix = data.filter(r => r.insider_name && ROLE_KW_RE.test(r.insider_name));
  console.log(`  Rows with role in name: ${toFix.length}`);

  if (toFix.length === 0) { console.log('  Nothing to fix.'); return; }

  let fixed = 0;
  for (const row of toFix) {
    const roleM = row.insider_name.match(ROLE_KW_RE);
    const cleanName = row.insider_name.slice(0, roleM.index).trim();
    const roleStr = roleM[0].replace(/^\s*,?\s*/, '').trim();

    const { error: ue } = await db
      .from('insider_transactions')
      .update({ insider_name: cleanName, insider_role: row.insider_role || roleStr })
      .eq('id', row.id);

    if (ue) { console.error(`  ❌ Update ${row.id}:`, ue.message); continue; }
    console.log(`  Fixed: "${row.insider_name}" → "${cleanName}" / role: "${roleStr}"`);
    fixed++;
  }
  console.log(`  ✅ Fixed ${fixed} rows`);
}

// ─── 4. Delete rows where transaction_type is truly unknown/invalid ───────────

async function deleteUnknownTypeRows() {
  console.log('\n── Step 4: Delete UNKNOWN transaction_type rows ─────────────────');

  const { count, error: ce } = await db
    .from('insider_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('transaction_type', 'UNKNOWN');

  if (ce) { console.error('  Count error:', ce.message); return; }
  console.log(`  Found ${count} UNKNOWN rows`);

  if (count === 0) { console.log('  Nothing to delete.'); return; }

  const { error } = await db
    .from('insider_transactions')
    .delete()
    .eq('transaction_type', 'UNKNOWN');

  if (error) { console.error('  ❌ Delete error:', error.message); return; }
  console.log(`  ✅ Deleted ${count} UNKNOWN rows`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔧 Data quality cleanup — insider_transactions');

  await deleteNlZeroPriceRows();
  await fixGermanyOtherTypes();
  await fixFranceRoleInName();
  await deleteUnknownTypeRows();

  console.log('\n✅ Done');
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
