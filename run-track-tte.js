'use strict';
/**
 * Run track-performance for a single ticker (default: TTE).
 * Usage: node run-track-tte.js [TICKER]
 */

require('dotenv').config();
const { createClient }                     = require('@supabase/supabase-js');
const { fetchYahooRange, findClosestPrice } = require('./scrapers/lib/yahooFinance');
const { getSuffixesForCountry, SPECIFIC_OVERRIDES } = require('./scrapers/lib/tickerMap');
const { PriceCache }                        = require('./scrapers/lib/priceCache');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const TODAY  = new Date().toISOString().slice(0, 10);
const TICKER = process.argv[2] || 'TTE';

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function calcReturn(buyPrice, laterPrice) {
  if (!buyPrice || !laterPrice || buyPrice <= 0) return null;
  return Math.round(((laterPrice - buyPrice) / buyPrice) * 10000) / 10000;
}

function needsUpdate(perf, txDate) {
  const horizons = [7, 30, 90, 180, 365];
  return horizons.filter(h => {
    const maturity = addDays(txDate, h);
    return maturity <= TODAY && perf[`return_${h}d`] == null;
  });
}

async function fetchRangeForTicker(ticker, countryCode, fromStr, toStr, cache) {
  const overrideSymbol = SPECIFIC_OVERRIDES[`${ticker}|${countryCode}`];
  const symbols = overrideSymbol
    ? [overrideSymbol]
    : getSuffixesForCountry(countryCode).map(sfx => ticker + sfx);
  for (const symbol of symbols) {
    const data = await cache.fetchRange(ticker, symbol, fromStr, toStr, fetchYahooRange);
    if (data && data.length > 0) return data;
  }
  return [];
}

async function run() {
  console.log(`\n📊  track-performance for ${TICKER}\n`);

  // Load existing perf rows for this ticker
  const existingMap = new Map();
  const { data: existing } = await supabase
    .from('insider_performance')
    .select('transaction_id, transaction_date, return_30d, return_90d, return_180d, return_365d')
    .eq('ticker', TICKER);
  (existing || []).forEach(r => existingMap.set(r.transaction_id, r));
  console.log(`  Existing perf rows: ${existingMap.size}`);

  const cutoffDate = addDays(TODAY, -7);
  const { data: allRows, error } = await supabase
    .from('insider_transactions')
    .select('id, ticker, company, insider_name, country_code, transaction_date, price_per_share, total_value')
    .eq('ticker', TICKER)
    .in('transaction_type', ['BUY', 'PURCHASE'])
    .gt('price_per_share', 0)
    .gt('total_value', 500)
    .or('is_unusual_price.is.null,is_unusual_price.eq.false')
    .lte('transaction_date', cutoffDate)
    .order('transaction_date', { ascending: false });

  if (error) { console.error('❌ Query error:', error.message); process.exit(1); }
  console.log(`  Eligible BUY rows: ${allRows.length}`);

  const newRows    = allRows.filter(r => !existingMap.has(r.id));
  const updateRows = allRows.filter(r => {
    const perf = existingMap.get(r.id);
    return perf && needsUpdate(perf, r.transaction_date).length > 0;
  });
  console.log(`  New rows to track:  ${newRows.length}`);
  console.log(`  Rows needing update: ${updateRows.length}`);

  const toProcess = [...newRows, ...updateRows];
  if (!toProcess.length) { console.log('  Nothing to process.'); return; }

  const cache  = new PriceCache();
  let upserted = 0;
  const skip   = { yahooEmpty: 0, fetchError: 0, dbError: 0, suspicious: 0 };
  const isISIN = t => /^[A-Z]{2}[A-Z0-9]{10}$/.test(t);

  for (const row of toProcess) {
    if (!row.insider_name || row.insider_name === 'Not disclosed') continue;
    if (!row.ticker || isISIN(row.ticker)) continue;

    try {
      const txPrice   = Number(row.price_per_share);
      const txDate    = row.transaction_date;
      const rangeFrom = addDays(txDate, 5);
      const rangeEnd  = addDays(txDate, 370);
      const actualEnd = rangeEnd > TODAY ? TODAY : rangeEnd;

      if (rangeFrom > TODAY) continue;

      const priceData = await fetchRangeForTicker(row.ticker, row.country_code, rangeFrom, actualEnd, cache);
      await new Promise(r => setTimeout(r, 150));

      if (!priceData.length) { skip.yahooEmpty++; continue; }

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

      const maxReturn = Math.max(Math.abs(r7 ?? 0), Math.abs(r30 ?? 0), Math.abs(r90 ?? 0), Math.abs(r180 ?? 0), Math.abs(r365 ?? 0));
      if (maxReturn > 10) { skip.suspicious++; console.warn(`  ⚠  Implausible return for ${row.company} @ ${txPrice}`); continue; }

      const perfRow = {
        insider_name:      row.insider_name,
        company:           row.company,
        ticker:            row.ticker,
        country_code:      row.country_code,
        transaction_id:    row.id,
        transaction_date:  txDate,
        transaction_price: txPrice,
        price_7d:   p7,  price_30d:  p30,  price_90d:  p90,  price_180d: p180, price_365d: p365,
        return_7d:  r7,  return_30d: r30,  return_90d: r90,  return_180d: r180, return_365d: r365,
        hit_rate_30d:  r30  !== null ? r30  > 0 : null,
        hit_rate_90d:  r90  !== null ? r90  > 0 : null,
        hit_rate_180d: r180 !== null ? r180 > 0 : null,
        hit_rate_365d: r365 !== null ? r365 > 0 : null,
        updated_at: new Date().toISOString(),
      };

      const { error: upErr } = await supabase
        .from('insider_performance')
        .upsert(perfRow, { onConflict: 'transaction_id' });

      if (upErr) { skip.dbError++; console.warn('  ⚠ DB:', upErr.message); continue; }
      upserted++;
      console.log(`  ✓ ${row.insider_name} | ${txDate} | buy=${txPrice} | 7d=${r7 != null ? (r7*100).toFixed(1)+'%' : 'pending'} | 30d=${r30 != null ? (r30*100).toFixed(1)+'%' : 'pending'}`);
    } catch (e) {
      skip.fetchError++;
      console.warn(`  ⚠ fetch error:`, e.message);
    }
  }

  console.log(`\n✅ Upserted: ${upserted} | Skipped: ${JSON.stringify(skip)}`);
}

run().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
