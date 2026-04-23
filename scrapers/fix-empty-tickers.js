'use strict';

/**
 * Diagnostic: lists companies with ticker='' so you can expand TICKER_MAP in their scrapers.
 *
 * For countries that use isinToTicker (FR, DE): re-run the scraper — the persistent
 * isin_ticker_cache will prevent rate-limit losses and resolve previously empty rows.
 *
 * For countries with ISIN in PDF but company-name TICKER_MAP (ES, IT, SE): scrapers
 * now have an isinToTicker fallback; re-running them will fill in empty-ticker rows.
 *
 * For NL (no ISIN in source): add the companies listed here to netherlands.js TICKER_MAP.
 *
 * Usage:
 *   node scrapers/fix-empty-tickers.js           # show all countries
 *   node scrapers/fix-empty-tickers.js --cc NL   # specific country
 */

const { createClient } = require('@supabase/supabase-js');

const CC_FILTER = (() => {
  const idx = process.argv.indexOf('--cc');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

async function main() {
  console.log(`📋  Empty-ticker diagnostics${CC_FILTER ? ` (${CC_FILTER})` : ''}`);

  // Fetch all rows with empty ticker
  let allRows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from('insider_transactions')
      .select('id, ticker, company, country_code, transaction_type, transaction_date')
      .eq('ticker', '');
    if (CC_FILTER) q = q.eq('country_code', CC_FILTER);
    const { data, error } = await q.range(from, from + 999);
    if (error) { console.error('❌ Query:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`  Total rows with ticker='': ${allRows.length}\n`);
  if (!allRows.length) { console.log('  Nothing to fix. ✅'); return; }

  // Group by country, then by company within each country
  const byCountry = new Map();
  for (const r of allRows) {
    if (!byCountry.has(r.country_code)) byCountry.set(r.country_code, new Map());
    const byCompany = byCountry.get(r.country_code);
    if (!byCompany.has(r.company)) byCompany.set(r.company, 0);
    byCompany.set(r.company, byCompany.get(r.company) + 1);
  }

  // Sort countries by total count descending
  const sortedCountries = [...byCountry.entries()]
    .sort(([, a], [, b]) => {
      const sumA = [...a.values()].reduce((s, v) => s + v, 0);
      const sumB = [...b.values()].reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });

  const USES_ISIN = new Set(['FR', 'DE', 'DK', 'FI', 'CH', 'PT']); // isinToTicker scrapers
  const ISIN_FALLBACK = new Set(['ES', 'IT', 'SE']); // now have ISIN fallback

  for (const [cc, byCompany] of sortedCountries) {
    const total = [...byCompany.values()].reduce((s, v) => s + v, 0);
    const fix = USES_ISIN.has(cc) ? '→ re-run scraper (isinToTicker)' :
                ISIN_FALLBACK.has(cc) ? '→ re-run scraper (ISIN fallback added)' :
                '→ add to TICKER_MAP in scraper';
    console.log(`  ${cc}: ${total} rows  [${fix}]`);

    // Show top companies (most rows first)
    const sorted = [...byCompany.entries()].sort(([, a], [, b]) => b - a);
    for (const [company, count] of sorted.slice(0, 10)) {
      console.log(`      ${count.toString().padStart(3)}x  ${company || '(null)'}`);
    }
    if (sorted.length > 10) console.log(`      ... and ${sorted.length - 10} more companies`);
    console.log();
  }
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
