import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const sb = createClient(SUPABASE_URL, ANON_KEY);

// Outlier caps per horizon — a real open-market buy's price shouldn't move this much
// in this little time; anything past this is treated as noise (bad ticker match,
// corporate action, etc.) and excluded from the average/win-rate, matching the
// bounds used elsewhere on the site for these horizons.
const HORIZONS = [
  { key: 'return_30d',  label: '30d',  cap: 0.50 },
  { key: 'return_90d',  label: '90d',  cap: 0.75 },
  { key: 'return_180d', label: '180d', cap: 1.00 },
];

async function fetchAll(table, selectCols, applyFilters) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(selectCols).range(from, from + 999);
    q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

function computeStats(rows, key, cap) {
  const capPct = cap * 100;
  const vals = rows
    .map(r => r.perf[key])
    .filter(v => v != null && Math.abs(v) * 100 <= capPct);
  const n = vals.length;
  if (n === 0) return { avg: null, winRate: null, n: 0 };
  const avg = vals.reduce((s, v) => s + v, 0) / n;
  const wins = vals.filter(v => v > 0).length;
  return {
    avg: Math.round(avg * 1000) / 10,          // fraction -> % with 1 decimal
    winRate: Math.round((wins / n) * 1000) / 10,
    n,
  };
}

function rowStatsBundle(rows) {
  const bundle = {};
  for (const h of HORIZONS) bundle[h.label] = computeStats(rows, h.key, h.cap);
  bundle.n_total = rows.length;
  return bundle;
}

const COUNTRY_NAMES = {
  DE: 'Germany', SE: 'Sweden', FR: 'France', ES: 'Spain', KR: 'South Korea',
  IT: 'Italy', GB: 'United Kingdom', NO: 'Norway', FI: 'Finland', NL: 'Netherlands',
  BE: 'Belgium', DK: 'Denmark', PL: 'Poland', LU: 'Luxembourg', PT: 'Portugal',
  AT: 'Austria', CZ: 'Czechia', HK: 'Hong Kong', IE: 'Ireland', JP: 'Japan',
  CA: 'Canada', SG: 'Singapore', CH: 'Switzerland', ZA: 'South Africa',
};
const COUNTRY_FLAGS = {
  DE: '🇩🇪', SE: '🇸🇪', FR: '🇫🇷', ES: '🇪🇸', KR: '🇰🇷', IT: '🇮🇹', GB: '🇬🇧',
  NO: '🇳🇴', FI: '🇫🇮', NL: '🇳🇱', BE: '🇧🇪', DK: '🇩🇰', PL: '🇵🇱', LU: '🇱🇺',
  PT: '🇵🇹', AT: '🇦🇹', CZ: '🇨🇿', HK: '🇭🇰', IE: '🇮🇪', JP: '🇯🇵', CA: '🇨🇦',
  SG: '🇸🇬', CH: '🇨🇭', ZA: '🇿🇦',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const txns = await fetchAll(
      'insider_transactions',
      'id,country_code,is_cluster_buy,is_price_dip,is_pre_blackout_buy,is_repetitive_buy,total_value',
      q => q
        .eq('transaction_type', 'BUY')
        .eq('is_unusual_price', false)
        .gt('price_per_share', 0)
        .gt('total_value', 1000)
        .neq('country_code', 'CH')
        .not('insider_name', 'is', null)
    );

    const perf = await fetchAll(
      'insider_performance',
      'transaction_id,return_30d,return_90d,return_180d',
      q => q
    );
    const perfById = new Map(perf.map(p => [p.transaction_id, p]));

    const rows = txns
      .map(t => ({ ...t, perf: perfById.get(t.id) }))
      .filter(t => t.perf);

    const overall = rowStatsBundle(rows);

    // Signalled vs. unsignalled comparison — a buy with at least one of the four
    // boolean signal flags, vs. every tracked buy. Used for the "signals vs. no
    // signal" callout on the Performance tab.
    const hasAnySignal = r => r.is_cluster_buy || r.is_price_dip || r.is_pre_blackout_buy || r.is_repetitive_buy;
    const statsAll         = overall;
    const statsWithSignals = rowStatsBundle(rows.filter(hasAnySignal));

    // Two specific combinations investigated separately and confirmed to
    // genuinely outperform the "any signal" baseline above (checked against
    // live data before adding these — see conversation/commit history):
    // price-dip buying alone, and large (>€50k) purchases with a signal.
    const statsPriceDip        = rowStatsBundle(rows.filter(r => r.is_price_dip));
    const statsHighValueSignal = rowStatsBundle(
      rows.filter(r => r.total_value > 50000 && (r.is_cluster_buy || r.is_price_dip))
    );

    const signalDefs = [
      { key: 'Cluster Buy',     test: r => r.is_cluster_buy },
      { key: 'Price Dip Buy',   test: r => r.is_price_dip },
      { key: 'Pre-Blackout',    test: r => r.is_pre_blackout_buy },
      { key: 'Repetitive Buy',  test: r => r.is_repetitive_buy },
      { key: 'No Signal',       test: r => !r.is_cluster_buy && !r.is_price_dip && !r.is_pre_blackout_buy && !r.is_repetitive_buy },
    ];
    const bySignal = signalDefs.map(({ key, test }) => ({
      signal: key,
      ...rowStatsBundle(rows.filter(test)),
    }));

    const byCountryMap = new Map();
    for (const r of rows) {
      if (!byCountryMap.has(r.country_code)) byCountryMap.set(r.country_code, []);
      byCountryMap.get(r.country_code).push(r);
    }
    const byCountry = [...byCountryMap.entries()]
      .map(([cc, ccRows]) => ({
        country_code: cc,
        country_name: COUNTRY_NAMES[cc] || cc,
        flag: COUNTRY_FLAGS[cc] || '',
        ...rowStatsBundle(ccRows),
      }))
      .sort((a, b) => b.n_total - a.n_total);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=43200');
    res.status(200).json({
      overall, bySignal, byCountry,
      stats_all: statsAll,
      stats_with_signals: statsWithSignals,
      stats_price_dip: statsPriceDip,
      stats_high_value_signal: statsHighValueSignal,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
