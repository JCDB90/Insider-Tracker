'use strict';
/**
 * One-off: fix bad Swedish tickers produced before the AB-prefix strip was added.
 * "AB Electrolux" → getTicker returned "AB" (AllianceBernstein), now returns "ELUX-B".
 * "Industrivärden C" etc. had similar issues.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Maps: bad ticker → { correct ticker, company name fragment to confirm match }
const FIXES = [
  { bad: 'AB',      good: 'ELUX-B',  fragment: 'electrolux' },
  { bad: 'INDUST',  good: 'INDU-C',  fragment: 'industri' },
  { bad: 'LIFCO',   good: 'LIFCO-B', fragment: 'lifco' },
  { bad: 'SAAB',    good: 'SAAB-B',  fragment: 'saab' },
  { bad: 'MIDSON',  good: 'MIDS-B',  fragment: 'midsona' },
  { bad: 'EPIROC',  good: 'EPI-B',   fragment: 'epiroc' },
  { bad: 'KINNE',   good: 'KINV-B',  fragment: 'kinnevik' },
  { bad: 'CASTE',   good: 'CAST',    fragment: 'castellum' },
  { bad: 'FINGER',  good: 'FING-B',  fragment: 'fingerprint' },
  { bad: 'NYFOS',   good: 'NYF',     fragment: 'nyfosa' },
  { bad: 'FASTU',   good: 'FASTU-B', fragment: 'fastighets' },
];

async function main() {
  for (const { bad, good, fragment } of FIXES) {
    // Count affected rows first
    const { data: rows, error: qErr } = await sb
      .from('insider_transactions')
      .select('filing_id, company, ticker')
      .eq('country_code', 'SE')
      .eq('ticker', bad)
      .ilike('company', `%${fragment}%`);

    if (qErr) { console.error(`  ❌ Query ${bad}:`, qErr.message); continue; }
    if (!rows || rows.length === 0) { console.log(`  ✓ ${bad} → ${good}: no rows to fix`); continue; }

    console.log(`  Fixing ${rows.length} rows: ${bad} → ${good} (${rows[0].company})`);

    const { error: uErr } = await sb
      .from('insider_transactions')
      .update({ ticker: good })
      .eq('country_code', 'SE')
      .eq('ticker', bad)
      .ilike('company', `%${fragment}%`);

    if (uErr) console.error(`  ❌ Update ${bad} → ${good}:`, uErr.message);
    else console.log(`  ✅ Updated ${rows.length} rows`);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
