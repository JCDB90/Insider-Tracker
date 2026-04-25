'use strict';
/**
 * Flag Signals — post-scrape enrichment
 *
 * Computes 4 boolean signal flags for every BUY transaction and writes them
 * to insider_transactions.  Run after score-insiders.js in the daily pipeline.
 *
 *   is_cluster_buy    — ≥2 DIFFERENT insiders at same company bought within 14 days
 *   is_repetitive_buy — same insider at same company made ≥2 buys within 14 days
 *   is_pre_earnings   — transaction falls 30–60 days before a known earnings date
 *   is_price_dip      — price_drawdown ≥ 10 % (stock dropped 10%+ before the buy)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const WINDOW_DAYS      = 14;   // cluster / repetitive window
const PRE_EARNINGS_MIN = 30;   // days before earnings — minimum
const PRE_EARNINGS_MAX = 60;   // days before earnings — maximum
const DIP_THRESHOLD    = 0.10; // 10 % drawdown
const BATCH_SIZE       = 200;  // upsert batch size

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

// ── Load earnings calendar ────────────────────────────────────────────────────

async function loadEarnings() {
  const { data, error } = await sb
    .from('earnings_calendar')
    .select('ticker, country_code, earnings_date')
    .gte('earnings_date', new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10));
  if (error) throw new Error('Load earnings: ' + error.message);
  // Group by ticker+country
  const map = {};
  for (const r of data || []) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!map[key]) map[key] = [];
    map[key].push(r.earnings_date);
  }
  return map;
}

// ── Signal computation ────────────────────────────────────────────────────────

function computeSignals(buys, earningsMap) {
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

    // ── CLUSTER: different insiders, same company, within window ──────────────
    const clusterPeers = peers.filter(p =>
      p.id !== t.id &&
      (p.insider_name || '').toLowerCase() !== (t.insider_name || '').toLowerCase() &&
      daysBetween(p.transaction_date, t.transaction_date) <= WINDOW_DAYS
    );
    const isCluster = clusterPeers.length >= 1; // ≥1 other different insider = cluster

    // ── REPETITIVE: same insider, same company, within window ─────────────────
    const repPeers = peers.filter(p =>
      p.id !== t.id &&
      (p.insider_name || '').toLowerCase() === (t.insider_name || '').toLowerCase() &&
      p.insider_name &&
      daysBetween(p.transaction_date, t.transaction_date) <= WINDOW_DAYS
    );
    const isRepetitive = repPeers.length >= 1;

    // ── PRE-EARNINGS: 30–60 days before a known earnings date ─────────────────
    let isPreEarnings = false;
    const earningsKey = `${t.ticker}|${t.country_code}`;
    const dates = earningsMap[earningsKey] || [];
    const txMs  = new Date(t.transaction_date).getTime();
    for (const ed of dates) {
      const edMs = new Date(ed).getTime();
      const daysBefore = (edMs - txMs) / 86400000;
      if (daysBefore >= PRE_EARNINGS_MIN && daysBefore <= PRE_EARNINGS_MAX) {
        isPreEarnings = true;
        break;
      }
    }

    // ── PRICE DIP: drawdown ≥ threshold ───────────────────────────────────────
    const isPriceDip = (t.price_drawdown != null && Number(t.price_drawdown) >= DIP_THRESHOLD);

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

async function upsertSignals(results) {
  const entries = Object.entries(results);
  let updated = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const updates = batch.map(([id, flags]) => ({ id: Number(id), ...flags }));

    // Supabase upsert with id as the conflict key
    const { error } = await sb
      .from('insider_transactions')
      .upsert(updates, { onConflict: 'id', ignoreDuplicates: false });

    if (error) {
      console.error(`  ❌ Upsert batch ${i}–${i + batch.length}: ${error.message}`);
    } else {
      updated += batch.length;
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

  console.log('  Loading earnings calendar…');
  const earningsMap = await loadEarnings();
  const earningsTickers = Object.keys(earningsMap).length;
  console.log(`  ${earningsTickers} tickers with earnings dates`);

  console.log('  Computing signals…');
  const results = computeSignals(buys, earningsMap);

  const cluster   = Object.values(results).filter(r => r.is_cluster_buy).length;
  const repetitive= Object.values(results).filter(r => r.is_repetitive_buy).length;
  const preEarn   = Object.values(results).filter(r => r.is_pre_earnings).length;
  const dip       = Object.values(results).filter(r => r.is_price_dip).length;

  console.log(`  Signals computed:`);
  console.log(`    🔄 Cluster buy:    ${cluster}`);
  console.log(`    🔁 Repetitive buy: ${repetitive}`);
  console.log(`    📅 Pre-earnings:   ${preEarn}`);
  console.log(`    📉 Price dip:      ${dip}`);

  console.log('  Writing to DB…');
  const updated = await upsertSignals(results);

  console.log(`  ✅ ${((Date.now() - t0) / 1000).toFixed(1)}s — ${updated} rows flagged`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
