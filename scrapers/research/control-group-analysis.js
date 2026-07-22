'use strict';

/**
 * Research: true control-group analysis for the price-dip insider-buying signal.
 *
 * Reader question: how much of the price-dip signal's forward return comes from
 * insider buying itself vs. simple mean reversion that follows any sharp
 * drawdown? To answer that we need a genuine control group — periods where a
 * stock had the same kind of drawdown but NO insider bought — which our
 * insider_transactions/insider_performance tables cannot provide on their own
 * (they only contain rows where an insider transaction occurred). This script
 * builds that control group independently from Yahoo Finance price history for
 * every ticker that has at least one real price-dip signal, then compares its
 * forward returns against the actual signal group.
 *
 * Methodology choices, and why (read before changing any of these):
 *
 * - 60-DAY lookback for the "recent high", not 90. This must exactly match
 *   scrapers/score-insiders.js's fetchHighBefore()/calcPriceDropScore(), which
 *   is what actually computed price_drawdown (and therefore is_price_dip) for
 *   every real transaction in the DB — its own comment says "60-day lookback:
 *   research sweet spot (90d too noisy)". Using a 90-day window here instead
 *   (as an earlier, unverified draft of this analysis proposed) would silently
 *   compare the signal group against a control group built on a DIFFERENT
 *   definition of "drawdown", making the two groups not actually comparable.
 * - Drawdown band 10%-60%, matching flag-signals.js's DIP_MIN/DIP_MAX.
 * - Forward returns use CALENDAR-day offsets via the shared findClosestPrice()
 *   helper (same one track-performance.js uses for the signal group's
 *   return_30d/return_90d) — not trading-day array indexing. Using array
 *   indices (prices[i+30]) would measure a ~42-calendar-day return under the
 *   label "30d", which is not comparable to the signal group's actual
 *   30-calendar-day return.
 * - ONE control observation per contiguous drawdown EPISODE, not one per
 *   trading day within it. A single 6-week drawdown touches the 10-60% band on
 *   most of its ~30 trading days; treating each of those as an independent
 *   "observation" would inflate N by an order of magnitude with heavily
 *   overlapping, non-independent data (adjacent days share almost the same
 *   forward-return window) and isn't a fair comparison to the signal group,
 *   where each row is a single discrete insider decision.
 * - Control dates within ±30 days of ANY real insider BUY for that ticker
 *   (not just price-dip-flagged ones) are excluded, so the control group is
 *   genuinely "drawdown, no nearby insider buying" rather than "drawdown, no
 *   nearby insider buying that happened to also be a price dip".
 * - Uses the project's existing Yahoo helpers (scrapers/lib/yahooFinance.js,
 *   scrapers/lib/tickerMap.js) — there is no yahoo-finance2 package installed
 *   in this project, and no resolveYahooSymbol() helper; ticker→Yahoo-symbol
 *   resolution reuses the same SPECIFIC_OVERRIDES/getSuffixesForCountry logic
 *   every other performance script in this repo already uses.
 */

const { createClient }                              = require('@supabase/supabase-js');
const { fetchYahooRange, findClosestPrice }          = require('../lib/yahooFinance');
const { getSuffixesForCountry, SPECIFIC_OVERRIDES }  = require('../lib/tickerMap');

const sb = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const LOOKBACK_DAYS       = 60;   // matches score-insiders.js's fetchHighBefore
const DIP_MIN             = 0.10; // matches flag-signals.js
const DIP_MAX             = 0.60; // matches flag-signals.js
const EXCLUDE_WINDOW_DAYS = 30;   // ± days around a real insider buy to exclude
const OUTLIER_CAP_30D     = 0.50; // matches the article's stated outlier caps
const OUTLIER_CAP_90D     = 0.75;
const FETCH_DELAY_MS      = 150;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchAll(table, cols, applyFilters) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function resolveAndFetch(ticker, countryCode, fromStr, toStr) {
  const overrideSymbol = SPECIFIC_OVERRIDES[`${ticker}|${countryCode}`];
  const symbols = overrideSymbol ? [overrideSymbol] : getSuffixesForCountry(countryCode).map(sfx => ticker + sfx);
  for (const symbol of symbols) {
    const data = await fetchYahooRange(symbol, fromStr, toStr);
    await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    if (data.length > 0) return data;
  }
  return [];
}

/** Highest close in (date-LOOKBACK_DAYS, date-1], using only prior data — no lookahead. */
function priorHigh(sorted, idx) {
  const targetDate = sorted[idx].date;
  const fromD = addDays(targetDate, -LOOKBACK_DAYS);
  const toD   = addDays(targetDate, -1);
  let hi = null;
  for (let j = idx - 1; j >= 0; j--) {
    if (sorted[j].date < fromD) break;
    if (sorted[j].date <= toD) hi = hi == null ? sorted[j].price : Math.max(hi, sorted[j].price);
  }
  return hi;
}

function stats(observations, key, cap) {
  const vals = observations.map(o => o[key]).filter(v => v != null && Math.abs(v) <= cap);
  const n = vals.length;
  if (n === 0) return { avg: null, winRate: null, n: 0 };
  const avg  = (vals.reduce((s, v) => s + v, 0) / n) * 100;
  const wins = vals.filter(v => v > 0).length;
  return { avg: Math.round(avg * 10) / 10, winRate: Math.round((wins / n) * 1000) / 10, n };
}

async function main() {
  console.log('📊  Control-group analysis — price-dip signal vs. drawdown-without-buying\n');
  const t0 = Date.now();

  console.log('Loading tickers with real price-dip signals…');
  const dipTxns = await fetchAll(
    'insider_transactions', 'ticker,country_code',
    q => q.eq('is_price_dip', true).eq('is_unusual_price', false).neq('country_code', 'CH').not('ticker', 'is', null)
  );
  const uniqueTickers = [...new Map(dipTxns.map(r => [`${r.ticker}|${r.country_code}`, r])).values()];
  console.log(`  ${uniqueTickers.length} unique tickers\n`);

  console.log('Loading all insider BUY dates (for exclusion window)…');
  const allBuys = await fetchAll(
    'insider_transactions', 'ticker,country_code,transaction_date',
    q => q.eq('transaction_type', 'BUY').not('ticker', 'is', null)
  );
  const buyDatesByTicker = new Map();
  for (const r of allBuys) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!buyDatesByTicker.has(key)) buyDatesByTicker.set(key, []);
    buyDatesByTicker.get(key).push(new Date(r.transaction_date + 'T12:00:00Z').getTime());
  }
  console.log(`  ${allBuys.length} total BUY rows loaded\n`);

  const today       = new Date().toISOString().slice(0, 10);
  const twoYearsAgo = addDays(today, -730);
  const fetchFrom   = addDays(twoYearsAgo, -LOOKBACK_DAYS); // extra room to compute the high near the window start

  const controlObservations = [];
  let processed = 0, fetchFailed = 0, episodesFound = 0, excludedNearInsider = 0;

  for (const { ticker, country_code } of uniqueTickers) {
    processed++;
    if (processed % 25 === 0) console.log(`  ${processed}/${uniqueTickers.length} tickers processed…`);

    const priceData = await resolveAndFetch(ticker, country_code, fetchFrom, today);
    if (priceData.length < LOOKBACK_DAYS + 30) { fetchFailed++; continue; }
    const sorted = [...priceData].sort((a, b) => a.date.localeCompare(b.date));
    const buyDates = buyDatesByTicker.get(`${ticker}|${country_code}`) || [];

    let inEpisode = false;
    for (let i = 0; i < sorted.length; i++) {
      const hi = priorHigh(sorted, i);
      if (hi == null) continue;
      const drawdown = (hi - sorted[i].price) / hi;
      const inRange  = drawdown >= DIP_MIN && drawdown <= DIP_MAX;

      if (inRange && !inEpisode) {
        // Start of a new contiguous drawdown episode — the only point we sample.
        episodesFound++;
        const dateMs = new Date(sorted[i].date + 'T12:00:00Z').getTime();
        const nearInsider = buyDates.some(bd => Math.abs(bd - dateMs) <= EXCLUDE_WINDOW_DAYS * 86400000);
        if (nearInsider) {
          excludedNearInsider++;
        } else {
          const p30 = findClosestPrice(sorted, addDays(sorted[i].date, 30));
          const p90 = findClosestPrice(sorted, addDays(sorted[i].date, 90));
          const r30 = p30 != null ? (p30 - sorted[i].price) / sorted[i].price : null;
          const r90 = p90 != null ? (p90 - sorted[i].price) / sorted[i].price : null;
          controlObservations.push({ ticker, country_code, date: sorted[i].date, drawdown, r30, r90 });
        }
      }
      inEpisode = inRange;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. Fetch failures: ${fetchFailed}/${uniqueTickers.length}`);
  console.log(`Drawdown episodes found: ${episodesFound} | excluded (insider bought within ±${EXCLUDE_WINDOW_DAYS}d): ${excludedNearInsider}`);
  console.log(`Clean control observations: ${controlObservations.length}\n`);

  const control30 = stats(controlObservations, 'r30', OUTLIER_CAP_30D);
  const control90 = stats(controlObservations, 'r90', OUTLIER_CAP_90D);

  console.log('=== CONTROL GROUP (drawdown, NO nearby insider buy) ===');
  console.log(`30d: avg=${control30.avg}%  win=${control30.winRate}%  n=${control30.n}`);
  console.log(`90d: avg=${control90.avg}%  win=${control90.winRate}%  n=${control90.n}`);

  console.log('\n=== SIGNAL GROUP (price-dip + insider buy) — for reference, computed separately ===');
  console.log('30d: avg=2.3%  win=58.4%  n=1199');
  console.log('90d: avg=5.0%  win=61.1%  n=653');

  console.log('\n=== INCREMENTAL VALUE (signal − control) ===');
  if (control30.avg != null) console.log(`30d avg: ${(2.3 - control30.avg).toFixed(1)}pp | win rate: ${(58.4 - control30.winRate).toFixed(1)}pp`);
  if (control90.avg != null) console.log(`90d avg: ${(5.0 - control90.avg).toFixed(1)}pp | win rate: ${(61.1 - control90.winRate).toFixed(1)}pp`);
}

main().catch(err => { console.error('❌ Fatal:', err.message, err.stack); process.exit(1); });
