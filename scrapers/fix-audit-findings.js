'use strict';
/**
 * Fix all findings from audit-data-quality.js
 *
 * Q1: Corporate entities → move to via_entity, clear insider_name
 * Q2: Untranslated roles → bulk translate
 * Q5: Garbage names  → delete confirmed parse artifacts, clear unknown shorts
 */
const { supabase } = require('./lib/db');

let fixed = 0, deleted = 0, errors = 0;

async function update(ids, patch, label) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('insider_transactions')
    .update(patch)
    .in('id', ids);
  if (error) { console.error(`  ❌ ${label}: ${error.message}`); errors++; }
  else        { console.log(`  ✅ ${label}: ${ids.length} row(s)`); fixed += ids.length; }
}

async function del(ids, label) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('insider_transactions')
    .delete()
    .in('id', ids);
  if (error) { console.error(`  ❌ DELETE ${label}: ${error.message}`); errors++; }
  else        { console.log(`  🗑  DELETE ${label}: ${ids.length} row(s)`); deleted += ids.length; }
}

// Bulk update by exact role string (no IDs needed — match on text)
async function updateByRole(oldRole, newRole, countryCode) {
  let q = supabase.from('insider_transactions').update({ insider_role: newRole }).eq('insider_role', oldRole);
  if (countryCode) q = q.eq('country_code', countryCode);
  const { error, count } = await q.select('id', { count: 'exact', head: true });
  if (error) {
    // Supabase JS v2: update doesn't return count easily — run without count
    const { error: e2 } = await supabase
      .from('insider_transactions').update({ insider_role: newRole }).eq('insider_role', oldRole)
      .eq('country_code', countryCode || '');
    if (e2) { console.error(`  ❌ role update "${oldRole}": ${e2.message}`); errors++; }
    else     { console.log(`  ✅ role "${oldRole}" → "${newRole}"`); fixed++; }
  } else {
    console.log(`  ✅ role "${oldRole}" → "${newRole}" (${count ?? '?'} rows)`);
    fixed++;
  }
}

async function bulkUpdateRole(oldRole, newRole, countryCode) {
  const { error } = await supabase
    .from('insider_transactions')
    .update({ insider_role: newRole })
    .eq('insider_role', oldRole)
    .eq('country_code', countryCode);
  if (error) { console.error(`  ❌ "${oldRole}": ${error.message}`); errors++; }
  else        { console.log(`  ✅ "${oldRole}" → "${newRole}" [${countryCode}]`); fixed++; }
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  // Q1 — CORPORATE ENTITIES → via_entity
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Q1: Corporate entities ─────────────────────────────────────');

  // FR: Bouygues SA board-seat filings — 27 rows total (26 + 1 variant)
  await update(
    ['91e4b2d1-b0df-41b4-b93c-70cb5a78a406','dcfc3be1-a814-4604-98c5-21fd15375f6e',
     '2a7f3a17-b97a-430a-a134-ee9ed7d67fb4','bb3860fa-951c-4de8-9144-ad147d540117'],
    { insider_name: null, via_entity: 'Bouygues SA' },
    'FR BOUYGUES SA (first batch)'
  );
  // Fetch remaining Bouygues rows dynamically
  {
    const { data } = await supabase.from('insider_transactions')
      .select('id')
      .ilike('insider_name', '%BOUYGUES SA%')
      .ilike('insider_name', '%TF1%')
      .eq('country_code', 'FR');
    const ids = (data || []).map(r => r.id);
    if (ids.length) await update(ids, { insider_name: null, via_entity: 'Bouygues SA' }, 'FR BOUYGUES SA (remaining)');
  }

  // FR: RTL Group GmbH
  await update(
    ['c24d69ac-1bd2-419f-bee8-202baabb0686','f42682db-4c1a-451b-a6dc-1478a5516b30',
     'ce2c3926-0b42-4f09-83fd-5e7d026c46ce'],
    { insider_name: null, via_entity: 'RTL Group Vermögensverwaltung GmbH' },
    'FR RTL Group GmbH (first batch)'
  );
  {
    const { data } = await supabase.from('insider_transactions')
      .select('id').ilike('insider_name', '%RTL Group Verm%').eq('country_code', 'FR');
    const ids = (data || []).map(r => r.id);
    if (ids.length) await update(ids, { insider_name: null, via_entity: 'RTL Group Vermögensverwaltung GmbH' }, 'FR RTL Group (remaining)');
  }

  // FR: RAPHAELLE DEFLESSELLE — real person, strip role suffix from name
  await update(
    ['7d01e456-7b6c-4389-ad08-7d104b9362a3','06ac962c-9250-457f-bd13-ebd7741255b9'],
    { insider_name: 'Raphaëlle Deflesselle', via_entity: 'Bouygues SA', insider_role: 'Board Member' },
    'FR Raphaëlle Deflesselle (clean name)'
  );

  // FR: David Cabero — real person, strip job title from name
  await update(
    ['9cab6620-f149-42c7-8e9f-5815b437218e'],
    { insider_name: 'David Cabero', insider_role: 'Group Category Leader' },
    'FR David Cabero (clean name)'
  );

  // FR: SMABTP société d'assurances mutuelles
  await update(
    ['8f3cf4a5-6058-4249-8d13-e764868a10b7','eaa510fc-816b-411c-ae73-f05aa029a3f5'],
    { insider_name: null, via_entity: 'SMABTP' },
    'FR SMABTP'
  );

  // FR: SMAvie BTP
  await update(
    ['bf93620d-07c0-4207-9c45-de53db4176ae'],
    { insider_name: null, via_entity: 'SMAvie BTP' },
    'FR SMAvie BTP'
  );

  // FR: LIMULE CAPITAL
  await update(
    ['597ba3ca-43b7-4424-924e-e1fd975d1bcb','db5982da-3b89-404b-873c-31c63029cf65',
     'bb28b899-7d33-4fc0-ba40-cb1ef0954734'],
    { insider_name: null, via_entity: 'Limule Capital' },
    'FR Limule Capital'
  );

  // FR: SR CAPITAL INVEST
  await update(
    ['23d92120-f037-4730-ae20-4b8f76271017'],
    { insider_name: null, via_entity: 'SR Capital Invest' },
    'FR SR Capital Invest'
  );

  // DE: Jeffrey and Laura Ubben 2000 Trust
  await update(
    ['5f40a604-c05c-42ac-bb2c-f174abe9eb16'],
    { insider_name: null, via_entity: 'Jeffrey and Laura Ubben 2000 Trust' },
    'DE Ubben Trust'
  );

  // DE: Rigsave Fund SICAV
  await update(
    ['891cacc2-f489-4a6b-91b2-03b5a6221fd1'],
    { insider_name: null, via_entity: 'Rigsave Fund SICAV' },
    'DE Rigsave Fund'
  );

  // ES: Arbitrage Capital Sicav
  await update(
    ['46fd4737-acd5-4a8d-8791-ec8cb0b2f2e2'],
    { insider_name: null, via_entity: 'Arbitrage Capital Sicav' },
    'ES Arbitrage Capital Sicav'
  );

  // BE: Capital Grand Est
  await update(
    ['1010c5eb-57d7-43e2-b86d-d0e9305da928','ac2b6a73-6d92-4dec-91e3-e1b76e5296d6'],
    { insider_name: null, via_entity: 'Capital Grand Est' },
    'BE Capital Grand Est'
  );

  // BE: Finsys Management
  await update(
    ['203f05d0-229b-4746-8230-c337f14287cf','dbf52000-4033-4d77-90f9-17107e2bc81d'],
    { insider_name: null, via_entity: 'Finsys Management' },
    'BE Finsys Management'
  );

  // SE: Dellner Invest (duplicated text in name)
  await update(
    ['fee68699-3474-4fa0-af2d-5bfa4315ab8c','bfdd0a3a-4ae8-499d-b147-d1c0462806d8'],
    { insider_name: null, via_entity: 'Dellner Invest' },
    'SE Dellner Invest'
  );

  // NO: "in Ocean Sun AS. Norda" — parse artifact, clear name (keep transaction)
  await update(
    ['69c14e66-5926-41fa-9277-378877076ef7'],
    { insider_name: null },
    'NO parse artifact "in Ocean Sun AS. Norda"'
  );

  // ══════════════════════════════════════════════════════════════════════════
  // Q2 — UNTRANSLATED ROLES  (bulk by role string)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Q2: Untranslated roles ─────────────────────────────────────');
  await bulkUpdateRole('Persona con Responsabilidad de Dirección', 'Senior Executive',  'ES');
  await bulkUpdateRole('Persona Estrechamente Vinculada',          'Closely Associated Person', 'ES');
  await bulkUpdateRole('Persona Rilevante',                        'Related Party',     'IT');
  // Catch any capitalisation variants
  {
    const variants = [
      ['Persona con responsabilidad de dirección', 'Senior Executive', 'ES'],
      ['PERSONA CON RESPONSABILIDAD DE DIRECCIÓN', 'Senior Executive', 'ES'],
      ['Persona estrechamente vinculada',           'Closely Associated Person', 'ES'],
      ['PERSONA ESTRECHAMENTE VINCULADA',           'Closely Associated Person', 'ES'],
      ['persona rilevante',                         'Related Party', 'IT'],
      ['PERSONA RILEVANTE',                         'Related Party', 'IT'],
    ];
    for (const [old, n, cc] of variants) await bulkUpdateRole(old, n, cc);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Q5 — GARBAGE NAMES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Q5: Garbage names ──────────────────────────────────────────');

  // NO "b)" — PDF section label extracted as name (Gjensidige Forsikring BUY)
  // Clear name; real transaction is kept for conviction scoring
  await update(
    ['ec514703-23e3-4cd6-9ebc-0d8f0feaf224'],
    { insider_name: null },
    'NO "b)" — clear parse artifact name'
  );

  // NO "2." — PDF section number (Olav Thon SELL 27M shares — valid transaction)
  await update(
    ['4634b9d6-47ad-45df-b155-9cf2476e1bf2'],
    { insider_name: null },
    'NO "2." — clear parse artifact name'
  );

  // IT "RHO" — 3x Equita Group SPA — likely Italian city name / parse artifact
  await update(
    ['eb384575-1984-458f-a8ee-3ba3b423bdec',
     'd5cabc98-a809-4ddc-a225-86c4ed347d9c',
     'da7d7747-2212-4eaf-92fb-3116b8cf8cc8'],
    { insider_name: null },
    'IT "RHO" — Equita Group (3 rows, clear name)'
  );

  // IT "CIS" — Assicurazioni Generali (likely abbreviation artifact)
  await update(
    ['8817a64e-d691-47c8-ab70-0aaafcc55ecd'],
    { insider_name: null },
    'IT "CIS" — Generali (clear name)'
  );

  // IT "LIM" — UniCredit SELL (likely abbreviation artifact)
  await update(
    ['ac66c30c-4cc2-4c2c-abe3-4275d59ddb55'],
    { insider_name: null },
    'IT "LIM" — UniCredit (clear name)'
  );

  // FR "FCB" — CEGEDIM BUY — likely company initials, not a person
  await update(
    ['b5609301-440c-46af-aa86-1e94b18c2f17'],
    { insider_name: null },
    'FR "FCB" — CEGEDIM (clear name)'
  );

  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n═══ Done — ${fixed} updated, ${deleted} deleted, ${errors} errors ═══`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
