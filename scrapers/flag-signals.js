'use strict';
/**
 * Flag Signals — post-scrape enrichment
 *
 * Computes 4 boolean signal flags for every BUY transaction and writes them
 * to insider_transactions.  Run after score-insiders.js in the daily pipeline.
 *
 *   is_cluster_buy      — ≥1 OTHER named insider at same company bought within 7 days
 *   is_repetitive_buy   — same insider at same company bought again, 4–14 days later
 *                         (gap < 4d = tranche execution, not a separate decision)
 *   is_pre_blackout_buy — transaction falls in the 7-day window just before an estimated
 *                         MAR quarterly blackout period begins
 *   is_price_dip        — price_drawdown 10–60% (caps out split/delisting outliers)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const CLUSTER_WINDOW   = 7;    // days — different insiders, same company
const REP_MIN_GAP      = 4;    // days — exclude 1–3 day tranche executions
const REP_MAX_GAP      = 14;   // days — same insider "came back" window
const DIP_MIN          = 0.10; // 10 % minimum drawdown
const DIP_MAX          = 0.60; // 60 % cap — above this is splits / bad data
const BATCH_SIZE       = 200;

// ── Pre-Blackout Buy windows ──────────────────────────────────────────────────
// The 7-day window immediately before the estimated MAR blackout period starts.
// Insiders buying in this tight window are committing capital at the last
// possible moment before they lose the ability to trade — a high-conviction signal.
//
//   Q1 blackout starts ~Mar 15  → signal window: Mar  8–15
//   Q2 blackout starts ~Jun 15  → signal window: Jun  8–15
//   Q3 blackout starts ~Sep 15  → signal window: Sep  8–15
//   Q4 blackout starts ~Jan  1  → signal window: Dec 24–31
const BLACKOUT_SIGNAL_WINDOWS = [
  { month: 3,  dayStart: 8,  dayEnd: 15 },
  { month: 6,  dayStart: 8,  dayEnd: 15 },
  { month: 9,  dayStart: 8,  dayEnd: 15 },
  { month: 12, dayStart: 24, dayEnd: 31 },
];

function isPreBlackoutBuy(dateStr) {
  const d   = new Date(dateStr);
  const m   = d.getMonth() + 1;
  const day = d.getDate();
  return BLACKOUT_SIGNAL_WINDOWS.some(w => m === w.month && day >= w.dayStart && day <= w.dayEnd);
}

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

// ── Load all BUY transactions ─────────────────────────────────────────────────

async function loadAllBuys() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_transactions')
      .select('id, company, ticker, country_code, insider_name, transaction_date, price_drawdown, price_per_share, is_unusual_price')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .not('transaction_date', 'is', null)
      .not('insider_name', 'is', null)
      .neq('country_code', 'CH')    // CH uses anonymous "Not disclosed" names — no signal value
      .order('transaction_date', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error('Load BUYs: ' + error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

// ── Signal computation ────────────────────────────────────────────────────────

function computeSignals(buys) {
  const results = {};   // id → { is_cluster_buy, is_repetitive_buy, is_pre_blackout_buy, is_price_dip, is_unusual_price }

  // Index by company (for cluster / repetitive detection)
  const byCompany = {};
  for (const t of buys) {
    const key = (t.company || t.ticker || '').toLowerCase();
    if (!byCompany[key]) byCompany[key] = [];
    byCompany[key].push(t);
  }

  for (const t of buys) {
    const companyKey = (t.company || t.ticker || '').toLowerCase();
    const peers      = byCompany[companyKey] || [];

    // ── UNUSUAL PRICE ─────────────────────────────────────────────────────────
    // Recomputed from scratch every run — the previous is_unusual_price value is
    // NEVER trusted as an input, because doing so made false positives permanent
    // (a wrong flag would exclude itself from the peer pool forever, so the median
    // could never recover and the flag could never clear).
    //
    //   1. price = 0 → free grant (RSU / LTIP vesting), always unusual.
    //   2. price <60% of same-company median from the last 90 days of KNOWN
    //      market-price peers → option exercise / deep-discount plan.
    // Coordinated same-day/same-price purchases (e.g. annual director share
    // plans) are NOT flagged on that pattern alone — only if the price itself
    // clears the 60% discount bar above. Without a peer median to compare
    // against, we do not flag: an unverifiable guess must not become permanent.
    let isUnusualPrice = t.price_per_share === 0;

    if (!isUnusualPrice && t.price_per_share > 0) {
      const recentPrices = peers
        .filter(p => !p.is_unusual_price && p.price_per_share > 1 && p.id !== t.id && daysBetween(p.transaction_date, t.transaction_date) <= 90)
        .map(p => p.price_per_share)
        .sort((a, b) => a - b);
      const recentMedian = recentPrices.length >= 2
        ? recentPrices[Math.floor(recentPrices.length / 2)]
        : null;

      if (recentMedian !== null) {
        isUnusualPrice = t.price_per_share < recentMedian * 0.60;
      }
    }

    if (isUnusualPrice) {
      results[t.id] = { is_cluster_buy: false, is_repetitive_buy: false, is_pre_blackout_buy: false, is_price_dip: false, is_unusual_price: true };
      continue;
    }

    // ── CLUSTER: different named insiders, same company, within 7 days ────────
    // Exclude unusual-price peers — an option exercise must not trigger a cluster
    // signal on a legitimate open-market purchase by another insider.
    const clusterPeers = peers.filter(p => {
      if (p.is_unusual_price) return false;
      if (!p.insider_name || !t.insider_name) return false;
      if ((p.insider_name || '').toLowerCase() === (t.insider_name || '').toLowerCase()) return false;
      return daysBetween(p.transaction_date, t.transaction_date) <= CLUSTER_WINDOW;
    });
    const isCluster = clusterPeers.length >= 1;

    // ── REPETITIVE: same named insider, shortest gap must be ≥ 4 days ─────────
    // Flag only when the CLOSEST other purchase is ≥ REP_MIN_GAP away.
    // Jan 1 + Jan 2 + Jan 7 → min gap = 1d → NOT flagged (tranche execution).
    // Jan 1 + Jan 8         → min gap = 7d → FLAGGED (genuine second decision).
    // Exclude unusual-price peers — an option exercise must not anchor a repetitive
    // buy signal on a genuine separate open-market decision.
    const samePeers = peers.filter(p => {
      if (p.is_unusual_price) return false;
      if (!p.insider_name || !t.insider_name) return false;
      if ((p.insider_name || '').toLowerCase() !== (t.insider_name || '').toLowerCase()) return false;
      const gap = daysBetween(p.transaction_date, t.transaction_date);
      return gap > 0 && gap <= REP_MAX_GAP;
    });
    const minGap = samePeers.length > 0
      ? Math.min(...samePeers.map(p => daysBetween(p.transaction_date, t.transaction_date)))
      : null;
    // Must have at least one same-insider peer AND the closest one must be >= 4 days away
    const isRepetitive = minGap !== null && minGap >= REP_MIN_GAP;

    // ── PRE-BLACKOUT: 7-day window before estimated MAR blackout starts ──────
    const isPreBlackout = isPreBlackoutBuy(t.transaction_date);

    // ── PRICE DIP: 10–60 % drawdown (excludes splits / delisting outliers) ────
    const dip = t.price_drawdown != null ? Number(t.price_drawdown) : null;
    const isPriceDip = dip !== null && dip >= DIP_MIN && dip <= DIP_MAX;

    results[t.id] = {
      is_cluster_buy:      isCluster,
      is_repetitive_buy:   isRepetitive,
      is_pre_blackout_buy: isPreBlackout,
      is_price_dip:        isPriceDip,
      is_unusual_price:    false,
    };
  }

  return results;
}

// ── Batch upsert ──────────────────────────────────────────────────────────────

async function upsertSignals(results, rawRows) {
  // Group rows by their exact flag combination so we can do bulk UPDATE ... WHERE id IN (...)
  // This avoids sending 4000 individual updates while keeping the id type native.
  const buckets = new Map(); // JSON(flags) → [id, ...]

  for (const row of rawRows) {
    const flags = results[row.id];
    if (!flags) continue;
    const key = JSON.stringify(flags);
    if (!buckets.has(key)) buckets.set(key, { flags, ids: [] });
    buckets.get(key).ids.push(row.id);
  }

  let updated = 0;
  for (const { flags, ids } of buckets.values()) {
    // Process in chunks of BATCH_SIZE to avoid PostgREST URL length limits
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const { error } = await sb
        .from('insider_transactions')
        .update(flags)
        .in('id', chunk);
      if (error) {
        console.error(`  ❌ Update chunk: ${error.message}`);
      } else {
        updated += chunk.length;
      }
    }
  }

  return updated;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚩  Flag Signals — enriching insider transactions');
  const t0 = Date.now();

  console.log('  Loading BUY transactions…');
  const buys = await loadAllBuys();
  console.log(`  ${buys.length} BUY transactions loaded`);

  console.log('  Computing signals (pre-blackout: 7-day windows before quarterly blackout)…');
  const results = computeSignals(buys);

  const cluster      = Object.values(results).filter(r => r.is_cluster_buy).length;
  const repetitive   = Object.values(results).filter(r => r.is_repetitive_buy).length;
  const preBlackout  = Object.values(results).filter(r => r.is_pre_blackout_buy).length;
  const dip          = Object.values(results).filter(r => r.is_price_dip).length;
  const unusualPrice = Object.values(results).filter(r => r.is_unusual_price).length;

  console.log(`  Signals computed:`);
  console.log(`    🔄 Cluster buy:      ${cluster}`);
  console.log(`    🔁 Repetitive buy:   ${repetitive}`);
  console.log(`    ⚠️  Pre-blackout buy: ${preBlackout}`);
  console.log(`    📉 Price dip:        ${dip}`);
  console.log(`    🔕 Unusual price:    ${unusualPrice} (signals suppressed)`);

  // ── Print examples for each signal type ──────────────────────────────────
  const examples = {
    cluster:     buys.find(r => results[r.id]?.is_cluster_buy),
    repetitive:  buys.find(r => results[r.id]?.is_repetitive_buy),
    preBlackout: buys.find(r => results[r.id]?.is_pre_blackout_buy),
    priceDip:    buys.find(r => results[r.id]?.is_price_dip),
  };
  if (examples.cluster)     console.log(`  🔄 Cluster example:       ${examples.cluster.company} — ${examples.cluster.insider_name} (${examples.cluster.transaction_date})`);
  if (examples.repetitive)  console.log(`  🔁 Repetitive example:    ${examples.repetitive.company} — ${examples.repetitive.insider_name} (${examples.repetitive.transaction_date})`);
  if (examples.preBlackout) console.log(`  ⚠️  Pre-blackout example:  ${examples.preBlackout.company} — ${examples.preBlackout.insider_name} (${examples.preBlackout.transaction_date})`);
  if (examples.priceDip)    console.log(`  📉 Price dip example:     ${examples.priceDip.company} — ${examples.priceDip.insider_name} (drawdown: ${(Number(examples.priceDip.price_drawdown)*100).toFixed(1)}%)`);

  console.log('  Writing to DB…');
  const updated = await upsertSignals(results, buys);

  console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s — ${updated} rows flagged`);

  // Clear is_pre_earnings on all rows (column replaced by is_pre_blackout_buy)
  await sb.from('insider_transactions').update({ is_pre_earnings: false }).neq('id', '00000000-0000-0000-0000-000000000000');

  // Clear signal flags for all CH transactions — Swiss insider names are anonymised
  // ("Not disclosed"), so cluster/repetitive signals are meaningless there.
  const { error: chErr } = await sb
    .from('insider_transactions')
    .update({ is_cluster_buy: false, is_repetitive_buy: false, is_pre_blackout_buy: false, is_unusual_price: false })
    .eq('country_code', 'CH');
  if (chErr) console.warn('  ⚠  CH flag-clear error:', chErr.message);
  else console.log('  ℹ  CH signal flags cleared (anonymous insiders)');
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
