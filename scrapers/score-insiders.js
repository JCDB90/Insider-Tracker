'use strict';

/**
 * Conviction Scoring V3 — Cluster Buying
 *
 * Three factors:
 *   1. Size score    (0.40) — log(1 + tradeValue / salaryProxy)
 *   2. Cluster score (0.30) — 30-day window of same insider+company buys, with multiplier
 *   3. Price drop    (0.30) — drawdown from 90d high before the buy date
 *
 * rawScore = size×0.4 + cluster×0.3 + priceScore×0.3
 * convictionNormalized = Math.min(100, rawScore × 25)
 *
 * When Yahoo price is unavailable: renormalize size+cluster across 0.70.
 *
 * New DB columns required (run migrations/003_cluster_scoring.sql first):
 *   cluster_value DECIMAL, cluster_size INTEGER,
 *   price_drawdown DECIMAL, conviction_normalized INTEGER,
 *   cluster_start DATE, cluster_end DATE
 */

const { createClient }           = require('@supabase/supabase-js');
const { fetchYahooRange }        = require('./lib/yahooFinance');
const { getSuffixesForCountry }  = require('./lib/tickerMap');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const BATCH_SIZE  = 50;
const BATCH_DELAY = 200; // ms between batches

// ─── Salary proxies & role weights ───────────────────────────────────────────

const ROLE_SALARY = {
  'CEO':                    500_000,
  'CFO':                    500_000,
  'Managing Director':      500_000,
  'Chairman':               300_000,
  'Chief Operating Officer':400_000,
  'Executive Director':     200_000,
  'Non-Executive Director': 100_000,
  'Board Member':           100_000,
  'Director':               150_000,
  'Other':                  100_000,
};

const ROLE_WEIGHT = {
  'CEO':                    1.00,
  'CFO':                    1.00,
  'Managing Director':      1.00,
  'Chairman':               0.90,
  'Chief Operating Officer':0.85,
  'Executive Director':     0.75,
  'Director':               0.60,
  'Board Member':           0.50,
  'Non-Executive Director': 0.40,
  'Other':                  0.30,
};

const ROLE_RULES = [
  [/\b(chief\s+exec|ceo)\b/i,                              'CEO'],
  [/\b(chief\s+fin|cfo|chief\s+financial)\b/i,             'CFO'],
  [/\b(managing\s+dir|directeur\s+g[eé]n|gérant)\b/i,     'Managing Director'],
  [/\b(chair(man|woman|person)?|voorzitter|pr[eé]sident)\b/i, 'Chairman'],
  [/\b(chief\s+oper|coo)\b/i,                              'Chief Operating Officer'],
  [/\b(exec(utive)?\s+dir|executive\s+vice|evp)\b/i,       'Executive Director'],
  [/\b(non.?exec|independent\s+dir|supervisory|commissar)\b/i, 'Non-Executive Director'],
  [/\b(board\s+member|member\s+of\s+(the\s+)?board)\b/i,   'Board Member'],
  [/\b(direct(or|eur|rice)|administrateur)\b/i,            'Director'],
];

function normalizeRole(raw) {
  if (!raw) return 'Other';
  for (const [re, normalized] of ROLE_RULES) {
    if (re.test(raw)) return normalized;
  }
  return 'Other';
}

function getRoleSalary(raw) {
  const role = normalizeRole(raw);
  return ROLE_SALARY[role] || 100_000;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}

// ─── Cluster detection ────────────────────────────────────────────────────────

// Build a map of insider+company → sorted array of all their BUY transactions
function buildClusterGroups(allBuys) {
  const groups = {};
  for (const t of allBuys) {
    if (!t.insider_name || !t.company) continue;
    const key = `${t.insider_name}|${t.company}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  }
  // Sort each group by date ascending
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  }
  return groups;
}

function getClusterInfo(tx, groups) {
  const key = `${tx.insider_name}|${tx.company}`;
  const group = groups[key];
  if (!group || group.length === 0) return { clusterSize: 1, clusterValue: Number(tx.total_value) || 0, clusterStart: tx.transaction_date, clusterEnd: tx.transaction_date };

  // All buys by same insider+company within 30 days of this transaction
  const nearby = group.filter(t => daysBetween(t.transaction_date, tx.transaction_date) <= 30);
  if (nearby.length === 0) return { clusterSize: 1, clusterValue: Number(tx.total_value) || 0, clusterStart: tx.transaction_date, clusterEnd: tx.transaction_date };

  const clusterSize  = nearby.length;
  const clusterValue = nearby.reduce((s, t) => s + (Number(t.total_value) || 0), 0);
  const dates = nearby.map(t => t.transaction_date).sort();
  return { clusterSize, clusterValue, clusterStart: dates[0], clusterEnd: dates[dates.length - 1] };
}

// ─── Yahoo price helpers (cached) ────────────────────────────────────────────

const priceRangeCache = new Map();

async function fetchHighBefore(ticker, countryCode, txDate) {
  if (!ticker || !txDate) return null;

  const from = addDays(txDate, -90);
  const to   = addDays(txDate, -1);
  const suffixes = getSuffixesForCountry(countryCode);

  for (const suffix of suffixes) {
    const symbol = ticker + suffix;
    const cacheKey = `${symbol}|${from}|${to}`;

    let data;
    if (priceRangeCache.has(cacheKey)) {
      data = priceRangeCache.get(cacheKey);
    } else {
      data = await fetchYahooRange(symbol, from, to);
      await new Promise(r => setTimeout(r, 150));
      priceRangeCache.set(cacheKey, data);
    }

    if (data && data.length > 0) {
      return Math.max(...data.map(d => d.price));
    }
  }
  return null;
}

// ─── Scoring factors ──────────────────────────────────────────────────────────

function calcSizeScore(tradeValue, salary) {
  if (!tradeValue || !salary) return 0;
  return Math.log(1 + Number(tradeValue) / salary);
}

function calcClusterScore(clusterValue, salary, clusterSize) {
  const base       = Math.log(1 + (Number(clusterValue) || 0) / salary);
  const multiplier = clusterSize >= 3 ? 1.5 : clusterSize >= 2 ? 1.2 : 1.0;
  return base * multiplier;
}

function calcPriceDropScore(recentHigh, buyPrice) {
  if (!recentHigh || !buyPrice || recentHigh <= 0) return null;
  const drawdown = (recentHigh - Number(buyPrice)) / recentHigh;
  if (drawdown <= 0) return { score: 0, drawdown: 0 };
  return {
    score:    Math.min(1, drawdown / 0.3),
    drawdown: Math.round(drawdown * 10000) / 10000,
  };
}

function calcFinalScore(sizeScore, clusterScore, priceResult) {
  if (priceResult !== null) {
    const raw = sizeScore * 0.4 + clusterScore * 0.3 + priceResult.score * 0.3;
    return Math.min(100, Math.round(raw * 25 * 10) / 10);
  }
  // Renormalize without price factor: weights 0.4 + 0.3 = 0.70
  const raw = (sizeScore * 0.4 + clusterScore * 0.3) / 0.70;
  return Math.min(100, Math.round(raw * 25 * 10) / 10);
}

function scoreLabel(normalized) {
  if (normalized >= 70) return 'High Conviction';
  if (normalized >= 40) return 'Medium Conviction';
  return 'Low Conviction';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎯  Insider Conviction Scoring V3 — Cluster Buying');
  const t0 = Date.now();

  // Verify new columns exist
  const { error: colCheck } = await supabase
    .from('insider_transactions')
    .select('conviction_score, cluster_size, cluster_value, price_drawdown, conviction_normalized')
    .limit(1);
  if (colCheck) {
    console.error('❌  Missing columns — run migrations/003_cluster_scoring.sql first');
    console.error('    SQL:\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS cluster_value DECIMAL;\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS cluster_size INTEGER;\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS price_drawdown DECIMAL;\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS conviction_normalized INTEGER;\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS cluster_start DATE;\n' +
      '    ALTER TABLE insider_transactions ADD COLUMN IF NOT EXISTS cluster_end DATE;'
    );
    process.exit(1);
  }

  // ── Phase 1: Load all BUY transactions for cluster context ──────────────────
  console.log('  Loading all BUY transactions for cluster context…');
  const allBuys = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, insider_name, company, ticker, country_code, insider_role, transaction_date, price_per_share, total_value')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .not('insider_name', 'is', null)
      .not('ticker', 'is', null)
      .order('transaction_date', { ascending: false })
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    allBuys.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  Loaded ${allBuys.length} BUY transactions for cluster context`);

  const clusterGroups = buildClusterGroups(allBuys);

  // ── Phase 2: Find rows to score (unscored, or all if --force) ───────────────
  const force = process.argv.includes('--force');
  if (force) console.log('  ⚡ --force mode: rescoring ALL transactions');

  const toScore = [];
  let from2 = 0;
  while (true) {
    let q = supabase
      .from('insider_transactions')
      .select('id, insider_name, company, ticker, country_code, insider_role, transaction_date, price_per_share, total_value')
      .in('transaction_type', ['BUY', 'PURCHASE'])
      .not('ticker', 'is', null)
      .not('insider_name', 'is', null)
      .order('transaction_date', { ascending: false })
      .range(from2, from2 + 999);
    if (!force) q = q.is('conviction_normalized', null);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    toScore.push(...data);
    if (data.length < 1000) break;
    from2 += 1000;
  }

  if (toScore.length === 0) { console.log('  Nothing to score.'); return; }
  console.log(`  Scoring ${toScore.length} transactions…`);

  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

  let scored = 0, withPrice = 0, skipped = 0;
  const skipReasons = {};
  function skip(reason) { skipped++; skipReasons[reason] = (skipReasons[reason] || 0) + 1; }

  // Process in batches of BATCH_SIZE
  for (let batchStart = 0; batchStart < toScore.length; batchStart += BATCH_SIZE) {
    const batch = toScore.slice(batchStart, batchStart + BATCH_SIZE);

    for (const row of batch) {
      try {
        if (!row.total_value || Number(row.total_value) <= 0) { skip('missing total_value'); continue; }
        // ISIN tickers: score without Yahoo price (priceResult stays null → renormalize size+cluster)

        const salary = getRoleSalary(row.insider_role);

        // Cluster info
        const { clusterSize, clusterValue, clusterStart, clusterEnd } = getClusterInfo(row, clusterGroups);

        // Factor 1: Size score
        const sizeScore    = calcSizeScore(row.total_value, salary);

        // Factor 2: Cluster score
        const clusterScore = calcClusterScore(clusterValue, salary, clusterSize);

        // Factor 3: Price drop (90d high before buy)
        let priceResult = null;
        if (row.ticker && row.transaction_date && row.price_per_share) {
          const recentHigh = await fetchHighBefore(row.ticker, row.country_code, row.transaction_date);
          if (recentHigh) {
            priceResult = calcPriceDropScore(recentHigh, row.price_per_share);
            withPrice++;
          }
        }

        const convictionNormalized = calcFinalScore(sizeScore, clusterScore, priceResult);
        const convictionScore      = Math.round(convictionNormalized) / 100; // keep 0-1 float for compat
        const label                = scoreLabel(convictionNormalized);

        const { error: upErr } = await supabase
          .from('insider_transactions')
          .update({
            conviction_score:      convictionScore,
            conviction_label:      label,
            conviction_normalized: Math.round(convictionNormalized),
            cluster_size:          clusterSize,
            cluster_value:         clusterValue,
            cluster_start:         clusterStart,
            cluster_end:           clusterEnd,
            price_drawdown:        priceResult?.drawdown ?? null,
          })
          .eq('id', row.id);

        if (upErr) { skip(`db error: ${upErr.message}`); }
        else { scored++; }

      } catch (err) {
        skip(`exception: ${err.message?.slice(0, 60)}`);
      }
    }

    if (scored % 100 === 0 && scored > 0) {
      console.log(`  Progress: ${scored}/${toScore.length} scored…`);
    }

    if (batchStart + BATCH_SIZE < toScore.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✅ ${elapsed}s — ${scored} scored, ${withPrice} with Yahoo price, ${skipped} skipped`);
  if (skipped > 0) {
    console.log('  Skip reasons:', JSON.stringify(skipReasons));
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
