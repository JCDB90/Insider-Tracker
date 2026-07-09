'use strict';
/**
 * One-off: normalize Swedish company names that spell out "Aktiebolag"/"Aktiebolaget"
 * (the long form of "AB") inconsistently with how the same issuer appears elsewhere,
 * fragmenting one company into multiple names in search/grouping/company pages.
 * Mirrors normalizeSECompany() added to sweden.js so future scrapes stay consistent.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function normalizeSECompany(name) {
  if (!name) return name;
  let n = name.trim();
  const commaForm = n.match(/^(.+?),\s*Investmentab\.?\s*$/i);
  if (commaForm) return `Investment AB ${commaForm[1].trim()}`;
  n = n.replace(/\b(\w+)aktiebolaget\b/gi, (_, root) => `${root} AB`);
  n = n.replace(/\bAktiebolag(?:et)?\b/gi, 'AB');
  return n.replace(/\s{2,}/g, ' ').trim();
}

async function main() {
  const { data: rows, error } = await sb
    .from('insider_transactions')
    .select('company')
    .eq('country_code', 'SE')
    .or('company.ilike.%aktiebolag%,company.ilike.%investmentab%');
  if (error) { console.error('❌ Query:', error.message); process.exit(1); }

  const distinct = [...new Set((rows || []).map(r => r.company))];
  console.log(`${distinct.length} distinct SE company name(s) matching Aktiebolag/Investmentab pattern`);

  for (const bad of distinct) {
    const good = normalizeSECompany(bad);
    if (good === bad) { console.log(`  = ${bad} (already normalized)`); continue; }

    const { data: affected, error: qErr } = await sb
      .from('insider_transactions')
      .select('id')
      .eq('country_code', 'SE')
      .eq('company', bad);
    if (qErr) { console.error(`  ❌ Query "${bad}":`, qErr.message); continue; }
    if (!affected || affected.length === 0) continue;

    const { error: uErr } = await sb
      .from('insider_transactions')
      .update({ company: good })
      .eq('country_code', 'SE')
      .eq('company', bad);

    if (uErr) console.error(`  ❌ Update "${bad}" → "${good}":`, uErr.message);
    else console.log(`  ✅ ${affected.length} row(s): "${bad}" → "${good}"`);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
