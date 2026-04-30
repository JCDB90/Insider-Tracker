'use strict';
/**
 * Flag Signals — post-scrape enrichment
 *
 * Computes 4 boolean signal flags for every BUY transaction and writes them
 * to insider_transactions.  Run after score-insiders.js in the daily pipeline.
 *
 *   is_cluster_buy    — ≥1 OTHER named insider at same company bought within 7 days
 *   is_repetitive_buy — same insider at same company bought again, 4–14 days later
 *                       (gap < 4d = tranche execution, not a separate decision)
 *   is_pre_earnings   — transaction falls 30–60 days before a known earnings date
 *   is_price_dip      — price_drawdown 10–60% (caps out split/delisting outliers)
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

// ── Deterministic pre-earnings blackout windows ───────────────────────────────
// Companies enter a trading blackout 30-45 days before quarterly results.
// An insider buying DURING the pre-blackout window (before it starts) is a
// stronger signal than buying at a random time.
//
// Standard EU quarterly reporting schedule:
//   Q1 results:  Apr 15 – May 30  → blackout starts Mar 1
//   Q2/H1:       Jul 15 – Aug 31  → blackout starts Jun 1
//   Q3:          Oct 15 – Nov 30  → blackout starts Sep 1
//   Q4/FY:       Jan 20 – Mar 31  → blackout starts Dec 6
//
// is_pre_earnings = true when a BUY falls inside one of these windows:
//   Q1 blackout:  March 1  – April 14
//   Q2 blackout:  June 1   – July 14
//   Q3 blackout:  September 1 – October 14
//   Q4 blackout:  December 6 – January 19
function isPreEarningsWindow(dateStr) {
  const d = new Date(dateStr);
  const m = d.getMonth() + 1; // 1–12
  const day = d.getDate();
  if (m === 3)                    return true;  // all of March
  if (m === 4 && day <= 14)       return true;  // Apr 1–14
  if (m === 6)                    return true;  // all of June
  if (m === 7 && day <= 14)       return true;  // Jul 1–14
  if (m === 9)                    return true;  // all of September
  if (m === 10 && day <= 14)      return true;  // Oct 1–14
  if (m === 12 && day >= 6)       return true;  // Dec 6–31
  if (m === 1 && day <= 19)       return true;  // Jan 1–19
  return false;
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
      .select('id, company, ticker, country_code, insider_name, transaction_date, price_drawdown')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .not('transaction_date', 'is', null)
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
  const results = {};   // id → { is_cluster_buy, is_repetitive_buy, is_pre_earnings, is_price_dip }

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

    // ── CLUSTER: different named insiders, same company, within 7 days ────────
    const clusterPeers = peers.filter(p => {
      if (!p.insider_name || !t.insider_name) return false;
      if ((p.insider_name || '').toLowerCase() === (t.insider_name || '').toLowerCase()) return false;
      return daysBetween(p.transaction_date, t.transaction_date) <= CLUSTER_WINDOW;
    });
    const isCluster = clusterPeers.length >= 1;

    // ── REPETITIVE: same named insider, shortest gap must be ≥ 4 days ─────────
    // Flag only when the CLOSEST other purchase is ≥ REP_MIN_GAP away.
    // Jan 1 + Jan 2 + Jan 7 → min gap = 1d → NOT flagged (tranche execution).
    // Jan 1 + Jan 8         → min gap = 7d → FLAGGED (genuine second decision).
    const samePeers = peers.filter(p => {
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

    // ── PRE-EARNINGS: deterministic quarterly blackout windows ───────────────
    const isPreEarnings = isPreEarningsWindow(t.transaction_date);

    // ── PRICE DIP: 10–60 % drawdown (excludes splits / delisting outliers) ────
    const dip = t.price_drawdown != null ? Number(t.price_drawdown) : null;
    const isPriceDip = dip !== null && dip >= DIP_MIN && dip <= DIP_MAX;

    results[t.id] = {
      is_cluster_buy:    isCluster,
      is_repetitive_buy: isRepetitive,
      is_pre_earnings:   isPreEarnings,
      is_price_dip:      isPriceDip,
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

  console.log('  Computing signals (pre-earnings: deterministic quarterly windows)…');
  const results = computeSignals(buys);

  const cluster   = Object.values(results).filter(r => r.is_cluster_buy).length;
  const repetitive= Object.values(results).filter(r => r.is_repetitive_buy).length;
  const preEarn   = Object.values(results).filter(r => r.is_pre_earnings).length;
  const dip       = Object.values(results).filter(r => r.is_price_dip).length;

  console.log(`  Signals computed:`);
  console.log(`    🔄 Cluster buy:    ${cluster}`);
  console.log(`    🔁 Repetitive buy: ${repetitive}`);
  console.log(`    📅 Pre-earnings:   ${preEarn}`);
  console.log(`    📉 Price dip:      ${dip}`);

  // ── Print examples for each signal type ──────────────────────────────────
  const examples = {
    cluster:    buys.find(r => results[r.id]?.is_cluster_buy),
    repetitive: buys.find(r => results[r.id]?.is_repetitive_buy),
    preEarnings:buys.find(r => results[r.id]?.is_pre_earnings),
    priceDip:   buys.find(r => results[r.id]?.is_price_dip),
  };
  if (examples.cluster)    console.log(`  🔄 Cluster example:    ${examples.cluster.company} — ${examples.cluster.insider_name} (${examples.cluster.transaction_date})`);
  if (examples.repetitive) console.log(`  🔁 Repetitive example: ${examples.repetitive.company} — ${examples.repetitive.insider_name} (${examples.repetitive.transaction_date})`);
  if (examples.preEarnings)console.log(`  📅 Pre-earn example:   ${examples.preEarnings.company} — ${examples.preEarnings.insider_name} (${examples.preEarnings.transaction_date}, ticker: ${examples.preEarnings.ticker})`);
  if (examples.priceDip)   console.log(`  📉 Price dip example:  ${examples.priceDip.company} — ${examples.priceDip.insider_name} (drawdown: ${(Number(examples.priceDip.price_drawdown)*100).toFixed(1)}%)`);

  console.log('  Writing to DB…');
  const updated = await upsertSignals(results, buys);

  console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s — ${updated} rows flagged`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
