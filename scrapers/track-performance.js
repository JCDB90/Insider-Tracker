'use strict';

/**
 * Insider Performance Tracker
 *
 * For each BUY transaction ≥7 days old, fetches post-trade prices at
 * +7d, +30d, +90d, +180d, +365d via a single Yahoo Finance range call,
 * then upserts to insider_performance.
 *
 * Also handles UPDATE runs: revisits existing rows where newer horizons
 * have now matured (e.g. a row tracked 60 days ago now has 90d data).
 *
 * Processes all eligible rows per run (no cap). Daily run via cron/GitHub Actions.
 */

const { createClient }                     = require('@supabase/supabase-js');
const { fetchYahooRange, findClosestPrice } = require('./lib/yahooFinance');
const { getSuffixesForCountry }             = require('./lib/tickerMap');

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

/** Which horizons are now mature but not yet recorded in this perf row? */
function needsUpdate(row, txDate) {
  const needsHorizons = [];
  const horizons = [
    { days: 30,  priceKey: 'price_30d',  returnKey: 'return_30d',  hitKey: 'hit_rate_30d'  },
    { days: 90,  priceKey: 'price_90d',  returnKey: 'return_90d',  hitKey: 'hit_rate_90d'  },
    { days: 180, priceKey: 'price_180d', returnKey: 'return_180d', hitKey: 'hit_rate_180d' },
    { days: 365, priceKey: 'price_365d', returnKey: 'return_365d', hitKey: 'hit_rate_365d' },
  ];
  for (const h of horizons) {
    const matureDate = addDays(txDate, h.days);
    if (matureDate <= TODAY && row[h.returnKey] === null) {
      needsHorizons.push(h);
    }
  }
  return needsHorizons;
}

async function main() {
  console.log('📈  Insider Performance Tracker (30d / 90d / 180d / 365d)');
  const t0 = Date.now();

  // Verify columns exist (migration 002 required)
  const { data: colCheck, error: colErr } = await supabase
    .from('insider_performance')
    .select('return_180d, return_365d, hit_rate_90d')
    .limit(1);
  if (colErr) {
    console.error('❌  insider_performance missing columns — run migrations/002_performance_extended.sql first');
    process.exit(1);
  }

  // ── Phase 1: new transactions (never tracked) ────────────────────────────

  // Load existing tracked IDs + their current state
  const existingMap = new Map(); // transaction_id → perf row
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('insider_performance')
      .select('id, transaction_id, transaction_date, transaction_price, return_30d, return_90d, return_180d, return_365d, hit_rate_30d, hit_rate_90d, hit_rate_180d, hit_rate_365d')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    data.forEach(r => existingMap.set(r.transaction_id, r));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  Existing perf rows: ${existingMap.size}`);

  // Fetch all eligible BUY transactions (>= 7d old, have price)
  const cutoffDate = addDays(TODAY, -7);
  let allRows = [];
  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, ticker, company, insider_name, country_code, transaction_date, price_per_share')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .not('ticker', 'is', null)
      .gt('price_per_share', 0)
      .lte('transaction_date', cutoffDate)
      .order('transaction_date', { ascending: false })
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const newRows    = allRows.filter(r => !existingMap.has(r.id));
  const updateRows = allRows.filter(r => {
    const perf = existingMap.get(r.id);
    return perf && needsUpdate(perf, r.transaction_date).length > 0;
  });

  console.log(`  New rows to track:  ${newRows.length}`);
  console.log(`  Rows needing update: ${updateRows.length}`);

  const toProcess = [...newRows, ...updateRows];
  if (toProcess.length === 0) { console.log('  Nothing to process.'); return; }

  let upserted = 0, errors = 0;

  const isISIN = t => /^[A-Z]{2}[A-Z0-9]{10}$/.test(t);

  for (const row of toProcess) {
    if (!row.ticker || isISIN(row.ticker)) { errors++; continue; } // can't look up ISIN on Yahoo
    try {
      const txPrice = Number(row.price_per_share);
      const txDate  = row.transaction_date;

      // Fetch a 370-day range in one call (covers all horizons)
      const rangeFrom = addDays(txDate, 5);
      const rangeEnd  = addDays(txDate, 370);
      const actualEnd = rangeEnd > TODAY ? TODAY : rangeEnd;

      if (rangeFrom > TODAY) continue;

      const priceData = await fetchRangeForTicker(row.ticker, row.country_code, rangeFrom, actualEnd);
      await new Promise(r => setTimeout(r, 120));

      const p7   = addDays(txDate, 7)   <= TODAY ? findClosestPrice(priceData, addDays(txDate, 7))   : null;
      const p30  = addDays(txDate, 30)  <= TODAY ? findClosestPrice(priceData, addDays(txDate, 30))  : null;
      const p90  = addDays(txDate, 90)  <= TODAY ? findClosestPrice(priceData, addDays(txDate, 90))  : null;
      const p180 = addDays(txDate, 180) <= TODAY ? findClosestPrice(priceData, addDays(txDate, 180)) : null;
      const p365 = addDays(txDate, 365) <= TODAY ? findClosestPrice(priceData, addDays(txDate, 365)) : null;

      const r7   = calcReturn(txPrice, p7);
      const r30  = calcReturn(txPrice, p30);
      const r90  = calcReturn(txPrice, p90);
      const r180 = calcReturn(txPrice, p180);
      const r365 = calcReturn(txPrice, p365);

      const perfRow = {
        insider_name:     row.insider_name || 'Not disclosed',
        company:          row.company,
        ticker:           row.ticker,
        country_code:     row.country_code,
        transaction_id:   row.id,
        transaction_date: txDate,
        transaction_price: txPrice,
        price_7d:   p7,
        price_30d:  p30,
        price_90d:  p90,
        price_180d: p180,
        price_365d: p365,
        return_7d:   r7,
        return_30d:  r30,
        return_90d:  r90,
        return_180d: r180,
        return_365d: r365,
        hit_rate_30d:  r30  !== null ? r30  > 0 : null,
        hit_rate_90d:  r90  !== null ? r90  > 0 : null,
        hit_rate_180d: r180 !== null ? r180 > 0 : null,
        hit_rate_365d: r365 !== null ? r365 > 0 : null,
        updated_at: new Date().toISOString(),
      };

      const { error: upErr } = await supabase
        .from('insider_performance')
        .upsert(perfRow, { onConflict: 'transaction_id' });

      if (upErr) { errors++; continue; }
      upserted++;

      // Backfill price_return_30d on the transaction row
      if (r30 !== null) {
        await supabase
          .from('insider_transactions')
          .update({ price_return_30d: r30 })
          .eq('id', row.id);
      }

      if (upserted % 50 === 0 && upserted > 0) {
        console.log(`  Progress: ${upserted}/${toProcess.length}…`);
      }
    } catch {
      errors++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${upserted} upserted, ${errors} errors`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
