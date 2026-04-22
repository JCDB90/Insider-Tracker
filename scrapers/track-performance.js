'use strict';

/**
 * Insider Performance Tracker
 *
 * For each BUY transaction that is ≥7 days old, fetches post-trade stock prices
 * at +7d, +30d, +90d and upserts to the insider_performance table.
 *
 * Also backfills price_return_30d on insider_transactions for quick dashboard
 * queries.
 *
 * Processes MAX_PER_RUN rows per daily run. For the initial backfill of 90 days
 * of data this will take 2–3 daily runs to complete.
 */

const { createClient }   = require('@supabase/supabase-js');
const { fetchYahooRange, findClosestPrice } = require('./lib/yahooFinance');
const { getSuffixesForCountry }            = require('./lib/tickerMap');

const MAX_PER_RUN = 300;

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const TODAY = new Date().toISOString().slice(0, 10);

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function calcReturn(buyPrice, laterPrice) {
  if (!buyPrice || !laterPrice || buyPrice <= 0) return null;
  return Math.round(((laterPrice - buyPrice) / buyPrice) * 10000) / 10000;
}

async function fetchRangeForTicker(ticker, countryCode, fromStr, toStr) {
  const suffixes = getSuffixesForCountry(countryCode);
  for (const suffix of suffixes) {
    const symbol = ticker + suffix;
    const data = await fetchYahooRange(symbol, fromStr, toStr);
    if (data.length > 0) return data;
    await new Promise(r => setTimeout(r, 150));
  }
  return [];
}

async function main() {
  console.log('📈  Insider Performance Tracker');
  const t0 = Date.now();

  // Verify table exists
  const { error: tableCheck } = await supabase
    .from('insider_performance')
    .select('id')
    .limit(1);
  if (tableCheck) {
    console.error('❌  insider_performance table missing — run migrations/001_scoring.sql first');
    process.exit(1);
  }

  // Find existing tracked transaction IDs (to skip already processed)
  const tracked = new Set();
  let from = 0;
  while (true) {
    const { data: existing } = await supabase
      .from('insider_performance')
      .select('transaction_id')
      .range(from, from + 999);
    if (!existing || existing.length === 0) break;
    existing.forEach(r => tracked.add(r.transaction_id));
    if (existing.length < 1000) break;
    from += 1000;
  }
  console.log(`  Already tracked: ${tracked.size} transactions`);

  // Fetch BUY transactions old enough to have 7d return
  const cutoffDate = addDays(TODAY, -7);
  const { data: rows, error } = await supabase
    .from('insider_transactions')
    .select('id, ticker, company, insider_name, country_code, transaction_date, price_per_share')
    .in('transaction_type', ['BUY', 'PURCHASE'])
    .not('ticker', 'is', null)
    .not('price_per_share', 'is', null)
    .gt('price_per_share', 0)
    .lte('transaction_date', cutoffDate)
    .order('transaction_date', { ascending: false })
    .limit(MAX_PER_RUN + tracked.size > 0 ? MAX_PER_RUN * 3 : MAX_PER_RUN); // over-fetch to skip tracked

  if (error) { console.error('❌ Query:', error.message); process.exit(1); }

  const untracked = (rows || []).filter(r => !tracked.has(r.id)).slice(0, MAX_PER_RUN);
  console.log(`  Untracked rows to process: ${untracked.length}`);

  if (untracked.length === 0) { console.log('  Nothing to track.'); return; }

  let upserted = 0, errors = 0;

  for (const row of untracked) {
    try {
      const txPrice = Number(row.price_per_share);
      const txDate  = row.transaction_date;

      // Fetch a 100-day range covering +7, +30, +90 days
      const rangeEnd = addDays(txDate, 95);
      const rangeFrom = addDays(txDate, 5);   // start 5d after tx to avoid same-day noise
      const actualEnd = rangeEnd > TODAY ? TODAY : rangeEnd;

      if (rangeFrom > TODAY) {
        // Transaction too recent even for 7d
        continue;
      }

      const priceData = await fetchRangeForTicker(
        row.ticker, row.country_code, rangeFrom, actualEnd
      );
      await new Promise(r => setTimeout(r, 120));

      const p7  = addDays(txDate, 7)  <= TODAY ? findClosestPrice(priceData, addDays(txDate, 7))  : null;
      const p30 = addDays(txDate, 30) <= TODAY ? findClosestPrice(priceData, addDays(txDate, 30)) : null;
      const p90 = addDays(txDate, 90) <= TODAY ? findClosestPrice(priceData, addDays(txDate, 90)) : null;

      const r7  = calcReturn(txPrice, p7);
      const r30 = calcReturn(txPrice, p30);
      const r90 = calcReturn(txPrice, p90);

      const perfRow = {
        insider_name:     row.insider_name || 'Not disclosed',
        company:          row.company,
        ticker:           row.ticker,
        country_code:     row.country_code,
        transaction_id:   row.id,
        transaction_date: txDate,
        transaction_price: txPrice,
        price_7d:  p7,
        price_30d: p30,
        price_90d: p90,
        return_7d:  r7,
        return_30d: r30,
        return_90d: r90,
        hit_rate_30d: r30 !== null ? r30 > 0 : null,
        updated_at: new Date().toISOString(),
      };

      const { error: upErr } = await supabase
        .from('insider_performance')
        .upsert(perfRow, { onConflict: 'transaction_id' });

      if (upErr) { errors++; continue; }
      upserted++;

      // Also update price_return_30d on the transaction row
      if (r30 !== null) {
        await supabase
          .from('insider_transactions')
          .update({ price_return_30d: r30 })
          .eq('id', row.id);
      }

      if (upserted % 30 === 0 && upserted > 0) {
        console.log(`  Progress: ${upserted}/${untracked.length}…`);
      }
    } catch (e) {
      errors++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${upserted} tracked, ${errors} errors`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
