'use strict';

/**
 * Manually-researched ticker assignments for companies that had zero rows
 * with any resolved ticker (so fix-missing-tickers-same-company.js had no
 * internal candidate to borrow from).
 *
 * Every symbol below was verified two ways before being added here:
 *   1. A live Yahoo Finance range fetch confirms the symbol returns data.
 *   2. The Yahoo close price on/near an actual recorded transaction_date is
 *      within normal daily-volatility range of that transaction's
 *      price_per_share (catches wrong-company / wrong-listing mismatches).
 *
 * Only touches rows where ticker is currently NULL/empty — never overwrites
 * an existing value.
 *
 * Usage:
 *   node scrapers/fix-missing-tickers-manual.js           # dry run
 *   node scrapers/fix-missing-tickers-manual.js --write   # apply
 */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = !process.argv.includes('--write');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// company (exact match) + country_code -> real exchange ticker.
// Default country-suffix mapping (lib/tickerMap.js) resolves all of these to
// a working Yahoo symbol EXCEPT Allwyn AG, which needs a SPECIFIC_OVERRIDES
// entry too (LU-registered but listed on Euronext Athens, not Luxembourg).
const ASSIGNMENTS = [
  { company: 'VICAT S.A.',                cc: 'FR', ticker: 'VCT' },
  { company: 'LOUIS HACHETTE GROUP S.A.', cc: 'FR', ticker: 'ALHG' },
  { company: 'Meta Wolf AG',              cc: 'DE', ticker: 'WOLF' },
  { company: 'LES CONSTRUCTEURS DU BOIS', cc: 'FR', ticker: 'MLLCB' },
  { company: 'SANOFI',                    cc: 'FR', ticker: 'SAN' },
  { company: 'ODIOT HOLDING',             cc: 'FR', ticker: 'MLODT' },
  { company: 'TXCOM',                     cc: 'FR', ticker: 'ALTXC' },
  { company: 'TRACTIAL',                  cc: 'FR', ticker: 'ALTRA' },
  { company: 'DASSAULT SYSTEMES',         cc: 'FR', ticker: 'DSY' },
  { company: 'SAFRAN',                    cc: 'FR', ticker: 'SAF' },
  { company: 'MERSEN',                    cc: 'FR', ticker: 'MRN' },
  { company: 'KLEA HOLDING',              cc: 'FR', ticker: 'ALKLH' },
  { company: 'Allwyn AG',                 cc: 'LU', ticker: 'ALWN' }, // needs SPECIFIC_OVERRIDES — see lib/tickerMap.js
  { company: 'LNA SANTE',                 cc: 'FR', ticker: 'LNA' },
  { company: 'GL EVENTS',                 cc: 'FR', ticker: 'GLO' },
  { company: 'ABC ARBITRAGE',             cc: 'FR', ticker: 'ABCA' },
  { company: 'HelloFresh SE',             cc: 'DE', ticker: 'HFG' },
];

// Explicitly NOT resolved — kept here as documentation, not applied:
//   Banca Popolare dell'Alto Adige SPA / Spa SPA / Spa (IT) — trades on
//   Vorvel, an Italian MTF that Yahoo Finance does not cover. No valid
//   Yahoo symbol exists; forcing one would be a guess. ~52 rows stay
//   ticker-less until this bank lists somewhere Yahoo tracks, or a
//   different price source is added for Vorvel-listed names.

async function main() {
  console.log(`🔧  Manual ticker assignment (${DRY_RUN ? 'DRY RUN' : 'WRITE MODE'})`);

  let totalUpdated = 0;
  for (const a of ASSIGNMENTS) {
    const { data: rows, error: selErr } = await supabase
      .from('insider_transactions')
      .select('id,ticker')
      .eq('company', a.company)
      .eq('country_code', a.cc);
    if (selErr) { console.error(`  ❌ ${a.company}:`, selErr.message); continue; }

    const toFix = (rows || []).filter(r => !r.ticker || r.ticker.trim() === '');
    if (toFix.length === 0) { console.log(`  - ${a.company} (${a.cc}): no empty-ticker rows`); continue; }

    console.log(`  ${a.company} (${a.cc}) -> ${a.ticker}  [${toFix.length} rows]`);
    if (DRY_RUN) continue;

    const ids = toFix.map(r => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const { error } = await supabase
        .from('insider_transactions')
        .update({ ticker: a.ticker })
        .in('id', batch);
      if (error) console.error(`    ❌ batch:`, error.message);
      else totalUpdated += batch.length;
    }
  }

  if (DRY_RUN) {
    console.log('\n  Dry run — pass --write to apply');
  } else {
    console.log(`\n  ✅ Updated ${totalUpdated} rows`);
  }
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
