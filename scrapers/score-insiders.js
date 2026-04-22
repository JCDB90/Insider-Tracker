'use strict';

/**
 * Conviction Scoring V2
 *
 * Scores all unscored BUY transactions using 4 factors:
 *   1. size_vs_salary    (0.35) — trade value relative to estimated role salary
 *   2. role_weight       (0.25) — seniority of the insider
 *   3. price_drop_before (0.25) — stock price drop in 30d before the buy
 *   4. transaction_size  (0.15) — absolute transaction value tier
 *
 * When Yahoo Finance price is unavailable, factors 1+2+4 are renormalized
 * across 0.75 total weight.
 *
 * Scores all unscored rows per run. Runs daily via GitHub Actions.
 */

const { createClient }       = require('@supabase/supabase-js');
const { getClosePriceAtOffset } = require('./lib/yahooFinance');

const MAX_PER_RUN = 10000;  // Score all unscored rows per run

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// ─── Role mappings ────────────────────────────────────────────────────────────

const ROLE_RULES = [
  // [match_pattern, weight, estimated_annual_salary_EUR]
  [/\b(chief\s+exec|ceo|managing\s+dir|directeur\s+g[eé]n)/i, 1.00, 500_000],
  [/\b(chief\s+fin|cfo|director\s+fin)/i,                     0.90, 300_000],
  [/\b(chair(man|woman|person)?|voorzitter|pr[eé]sident\b)/i, 0.85, 400_000],
  [/\b(chief\s+oper|coo)/i,                                   0.80, 280_000],
  [/\b(chief\s+(tech|info|invest)|cto|cio|ciso)/i,            0.75, 250_000],
  [/\b(exec(utive)?\s+dir|executive\s+vice|evp)/i,            0.70, 200_000],
  [/\b(senior\s+vice|svp|senior\s+director)/i,                0.65, 180_000],
  [/\b(vice\s+president|vp\b)/i,                              0.60, 160_000],
  [/\b(direct(or|eur|rice)|administrateur|board\s+member)/i,  0.55, 150_000],
  [/\b(non.?exec|independent\s+dir|supervisory|commissar)/i,  0.40, 100_000],
  [/\b(secretary|controller|treasurer|comptroller)/i,         0.40, 120_000],
];

function getRoleWeightAndSalary(role) {
  if (!role) return { weight: 0.40, salary: 100_000 };
  for (const [re, weight, salary] of ROLE_RULES) {
    if (re.test(role)) return { weight, salary };
  }
  return { weight: 0.40, salary: 100_000 };
}

// ─── Factor calculators ───────────────────────────────────────────────────────

function calcSizeVsSalary(totalValue, salary) {
  if (!totalValue || !salary) return 0;
  const ratio = Number(totalValue) / salary;
  return Math.min(ratio, 5) / 5; // cap at 5x salary, normalize 0-1
}

function calcTransactionSizeTier(totalValue) {
  const v = Number(totalValue) || 0;
  if (v >= 1_000_000) return 1.00;
  if (v >= 500_000)   return 0.90;
  if (v >= 100_000)   return 0.70;
  if (v >= 50_000)    return 0.50;
  if (v >= 10_000)    return 0.30;
  return 0.10;
}

function calcPriceDropFactor(priceNow, price30dAgo) {
  if (!priceNow || !price30dAgo || price30dAgo <= 0) return null;
  const dropPct = (price30dAgo - priceNow) / price30dAgo; // positive = stock fell
  const clamped = Math.max(-1, Math.min(1, dropPct));
  return (clamped + 1) / 2; // map [-1,+1] → [0,1]
}

function finalScore(f1, f2, f3, f4) {
  if (f3 !== null) {
    return f1 * 0.35 + f2 * 0.25 + f3 * 0.25 + f4 * 0.15;
  }
  // Renormalize without price factor: 0.35+0.25+0.15 = 0.75
  return (f1 * 0.35 + f2 * 0.25 + f4 * 0.15) / 0.75;
}

function scoreLabel(score) {
  if (score >= 0.70) return 'High Conviction';
  if (score >= 0.40) return 'Medium Conviction';
  return 'Low Conviction';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎯  Insider Conviction Scoring V2');
  const t0 = Date.now();

  // Verify column exists
  const { error: colCheck } = await supabase
    .from('insider_transactions')
    .select('conviction_score')
    .limit(1);
  if (colCheck) {
    console.error('❌  conviction_score column missing — run migrations/001_scoring.sql first');
    process.exit(1);
  }

  // Fetch all unscored BUY transactions (paginated — PostgREST max_rows = 1000)
  const rows = [];
  let from = 0;
  while (rows.length < MAX_PER_RUN) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, ticker, company, country_code, insider_role, transaction_date, price_per_share, total_value')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .is('conviction_score', null)
      .not('ticker', 'is', null)
      .order('transaction_date', { ascending: false })
      .range(from, from + 999);
    if (error) { console.error('❌ Query:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  if (rows.length === 0) { console.log('  Nothing to score.'); return; }

  console.log(`  Scoring ${rows.length} BUY transactions…`);

  let scored = 0, withPrice = 0, errors = 0;

  for (const row of rows) {
    try {
      const { weight: roleWeight, salary } = getRoleWeightAndSalary(row.insider_role);

      const f1 = calcSizeVsSalary(row.total_value, salary);
      const f2 = roleWeight;
      const f4 = calcTransactionSizeTier(row.total_value);

      // Factor 3: try to get price 30d before the buy
      let f3 = null;
      let price30dBefore = null;
      if (row.ticker && row.transaction_date && row.price_per_share) {
        price30dBefore = await getClosePriceAtOffset(
          row.ticker, row.transaction_date, -30, row.country_code
        );
        if (price30dBefore) {
          f3 = calcPriceDropFactor(Number(row.price_per_share), price30dBefore);
          withPrice++;
        }
        await new Promise(r => setTimeout(r, 100));
      }

      const score = Math.round(finalScore(f1, f2, f3, f4) * 1000) / 1000;
      const label = scoreLabel(score);

      const { error: upErr } = await supabase
        .from('insider_transactions')
        .update({
          conviction_score: score,
          conviction_label: label,
          price_30d_before: price30dBefore,
        })
        .eq('id', row.id);

      if (upErr) { errors++; }
      else { scored++; }

      if (scored % 50 === 0 && scored > 0) {
        console.log(`  Progress: ${scored}/${rows.length} scored…`);
      }
    } catch (e) {
      errors++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${scored} scored (${withPrice} with Yahoo price, ${errors} errors)`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
