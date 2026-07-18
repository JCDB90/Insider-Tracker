'use strict';

/**
 * Backfill NULL/empty tickers by borrowing a known-good ticker from other rows
 * of the same (company, country_code) pair.
 *
 * Many companies have a mix of rows where the ticker resolved correctly (via
 * isinToTicker / TICKER_MAP at scrape time) and rows where it didn't — same
 * company, same filings source, just an inconsistent resolution across scrape
 * runs. When a (company, country_code) has EXACTLY ONE distinct non-empty,
 * non-ISIN ticker across all its rows, that's a high-confidence backfill for
 * every empty-ticker row of that company. Companies with zero or with multiple
 * conflicting tickers are left untouched — those need manual review, not a
 * guess.
 *
 * Usage:
 *   node scrapers/fix-missing-tickers-same-company.js           # dry run
 *   node scrapers/fix-missing-tickers-same-company.js --write   # apply
 */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = !process.argv.includes('--write');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const isISIN = t => /^[A-Z]{2}[A-Z0-9]{10}$/.test(t);

async function fetchAll(table, select) {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) { console.error(`❌ Query ${table}:`, error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  console.log(`🔧  Same-company ticker backfill (${DRY_RUN ? 'DRY RUN' : 'WRITE MODE'})`);

  const all = await fetchAll('insider_transactions', 'id,company,ticker,country_code');
  console.log(`  Loaded ${all.length} rows`);

  const byCoCC = new Map(); // "company|cc" -> { empty: [ids], tickers: Map<ticker,count> }
  for (const r of all) {
    const key = `${r.company}|${r.country_code}`;
    if (!byCoCC.has(key)) byCoCC.set(key, { empty: [], tickers: new Map() });
    const g = byCoCC.get(key);
    if (!r.ticker || r.ticker.trim() === '') {
      g.empty.push(r.id);
    } else if (!isISIN(r.ticker)) {
      g.tickers.set(r.ticker, (g.tickers.get(r.ticker) || 0) + 1);
    }
  }

  const plan = [];
  let ambiguous = 0;
  for (const [key, g] of byCoCC) {
    if (g.empty.length === 0) continue;
    const distinct = [...g.tickers.keys()];
    if (distinct.length === 1) {
      const [company, cc] = key.split('|');
      plan.push({ company, cc, ticker: distinct[0], ids: g.empty });
    } else if (distinct.length > 1) {
      ambiguous++;
    }
  }

  const totalRows = plan.reduce((s, p) => s + p.ids.length, 0);
  console.log(`  Backfillable: ${plan.length} companies, ${totalRows} rows`);
  console.log(`  Skipped (ambiguous — multiple distinct tickers seen): ${ambiguous} companies`);

  for (const p of plan.sort((a, b) => b.ids.length - a.ids.length).slice(0, 20)) {
    console.log(`    ${p.company} (${p.cc}) -> ${p.ticker}  [${p.ids.length} rows]`);
  }

  if (DRY_RUN) {
    console.log('\n  Dry run — pass --write to apply');
    return;
  }

  let updated = 0;
  for (const p of plan) {
    for (let i = 0; i < p.ids.length; i += 100) {
      const batch = p.ids.slice(i, i + 100);
      const { error } = await supabase
        .from('insider_transactions')
        .update({ ticker: p.ticker })
        .in('id', batch);
      if (error) console.error(`  ❌ ${p.company} (${p.cc}):`, error.message);
      else updated += batch.length;
    }
  }
  console.log(`\n  ✅ Backfilled ${updated} rows across ${plan.length} companies`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
