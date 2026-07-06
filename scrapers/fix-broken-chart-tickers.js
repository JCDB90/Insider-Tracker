'use strict';
/**
 * One-off: fix tickers stored before this batch of chart-mapping fixes.
 *   - "Scandi Standard" and "Lagercrantz" auto-derived to non-existent Yahoo symbols.
 *   - Five unrelated real-estate companies were collapsed onto the same
 *     nonexistent ticker (FASTU-B) by an overly-broad "fastighets" substring match.
 *   - Redeia's ticker (REE) was delisted on Yahoo after the 2023 rename from
 *     Red Eléctrica; RED is the live symbol.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const FIXES = [
  { country: 'SE', bad: 'SCANDI',  good: 'SCST',       fragment: 'scandi standard' },
  { country: 'SE', bad: 'LAGERC',  good: 'LAGR-B',      fragment: 'lagercrantz' },
  { country: 'SE', bad: 'FASTU-B', good: 'EMIL-B',      fragment: 'emilshus' },
  { country: 'SE', bad: 'FASTU-B', good: 'JOMA',        fragment: 'mattson' },
  { country: 'SE', bad: 'FASTU-B', good: 'TINGS-PREF',  fragment: 'tingsvalvet' },
  { country: 'SE', bad: 'FASTU-B', good: 'TRIAN-B',     fragment: 'trianon' },
  { country: 'SE', bad: 'FASTU-B', good: 'BALD-B',      fragment: 'balder' },
  { country: 'ES', bad: 'REE',     good: 'RED',         fragment: 'redeia' },
];

async function main() {
  for (const { country, bad, good, fragment } of FIXES) {
    const { data: rows, error: qErr } = await sb
      .from('insider_transactions')
      .select('id, company, ticker')
      .eq('country_code', country)
      .eq('ticker', bad)
      .ilike('company', `%${fragment}%`);

    if (qErr) { console.error(`  ❌ Query ${country}/${bad}:`, qErr.message); continue; }
    if (!rows || rows.length === 0) { console.log(`  ✓ ${country} ${bad} → ${good} (${fragment}): no rows to fix`); continue; }

    console.log(`  Fixing ${rows.length} rows: ${country} ${bad} → ${good} (${rows[0].company})`);

    const { error: uErr } = await sb
      .from('insider_transactions')
      .update({ ticker: good })
      .eq('country_code', country)
      .eq('ticker', bad)
      .ilike('company', `%${fragment}%`);

    if (uErr) console.error(`  ❌ Update ${country} ${bad} → ${good}:`, uErr.message);
    else console.log(`  ✅ Updated ${rows.length} rows`);
  }
  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
