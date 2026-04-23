import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://loqmxllfjvdwamwicoow.supabase.co',
  'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// ─── Constants ────────────────────────────────────────────────────────────────

const COUNTRY_FLAGS = {
  AT: '🇦🇹', BE: '🇧🇪', CA: '🇨🇦', CH: '🇨🇭', CZ: '🇨🇿',
  DE: '🇩🇪', DK: '🇩🇰', ES: '🇪🇸', FI: '🇫🇮', FR: '🇫🇷', GB: '🇬🇧',
  HK: '🇭🇰', IE: '🇮🇪', IT: '🇮🇹', JP: '🇯🇵', KR: '🇰🇷',
  LU: '🇱🇺', NL: '🇳🇱', NO: '🇳🇴', PL: '🇵🇱', PT: '🇵🇹',
  SE: '🇸🇪', SG: '🇸🇬', ZA: '🇿🇦',
};

const COUNTRY_NAMES = {
  AT: 'Austria',      BE: 'Belgium',        CA: 'Canada',
  CH: 'Switzerland',  CZ: 'Czech Republic', DE: 'Germany',
  DK: 'Denmark',      ES: 'Spain',          FI: 'Finland',
  FR: 'France',       GB: 'United Kingdom', HK: 'Hong Kong',
  IE: 'Ireland',      IT: 'Italy',          JP: 'Japan',
  KR: 'South Korea',  LU: 'Luxembourg',     NL: 'Netherlands',
  NO: 'Norway',       PL: 'Poland',         PT: 'Portugal',
  SE: 'Sweden',       SG: 'Singapore',      ZA: 'South Africa',
};

const TRACKED_MARKETS = Object.keys(COUNTRY_FLAGS).sort();

const ACCENT = '#1B2CC1';

// ─── Watchlist (personal stocks) ─────────────────────────────────────────────

const WATCHLIST = [
  { ticker: 'VID',  company: 'Vidrala',       country: 'ES', yahoo: 'VID.MC'   },
  { ticker: 'THEP', company: 'Thermador',      country: 'FR', yahoo: 'THEP.PA'  },
  { ticker: 'PRX',  company: 'Prosus',         country: 'NL', yahoo: 'PRX.AS'   },
  { ticker: 'ASML', company: 'ASML',           country: 'NL', yahoo: 'ASML.AS'  },
  { ticker: 'FLOW', company: 'Flow Traders',   country: 'NL', yahoo: 'FLOW.AS'  },
  { ticker: 'JEN',  company: 'Jensen Group',   country: 'BE', yahoo: 'JEN.BR'   },
];

const WATCHLIST_TICKERS = new Set(WATCHLIST.map(w => w.ticker));

// Match a transaction to a watchlist entry — requires both ticker AND country to match,
// preventing ticker collisions (e.g. VID = Vidrala ES and Videndum GB)
function matchesWatchlist(t) {
  return WATCHLIST.some(w => w.ticker === t.ticker && w.country === t.country_code);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', KRW: '₩',
  AUD: 'A$', CAD: 'C$', HKD: 'HK$', SGD: 'S$', ZAR: 'R',
  CHF: 'CHF\u00a0', SEK: 'SEK\u00a0', DKK: 'DKK\u00a0', NOK: 'NOK\u00a0',
  PLN: 'PLN\u00a0', CZK: 'CZK\u00a0',
};

function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] ?? (currency ? currency + '\u00a0' : '€');
}

function formatValue(value, currency = 'EUR') {
  if (value == null || value === '' || isNaN(value)) return '—';
  const num = Number(value);
  if (num === 0) return '—';
  const sym = currencySymbol(currency);
  if (num >= 1e9) return `${sym}${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `${sym}${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${sym}${(num / 1e3).toFixed(0)}K`;
  return `${sym}${num.toFixed(0)}`;
}

function formatPrice(value, currency = 'EUR') {
  if (value == null || isNaN(value)) return '—';
  const sym = currencySymbol(currency);
  return `${sym}${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShares(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function sortRows(rows, sortBy, sortDir, numericKeys = []) {
  return [...rows].sort((a, b) => {
    let av = a[sortBy] ?? '';
    let bv = b[sortBy] ?? '';
    if (numericKeys.includes(sortBy)) { av = Number(av); bv = Number(bv); }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ─── Design Components ────────────────────────────────────────────────────────

function TypeChip({ type }) {
  const t = (type || '').toUpperCase();
  const isBuy = t === 'BUY' || t === 'PURCHASE';
  const isSell = t === 'SELL' || t === 'SALE';
  if (isBuy) return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontWeight: 600, fontSize: 12,
      color: '#15803D', background: '#F0FDF4',
      borderRadius: 4, padding: '2px 8px',
    }}>
      <svg width="7" height="7" viewBox="0 0 8 8" fill="#15803D"><polygon points="4,1 7,6 1,6" /></svg>
      BUY
    </span>
  );
  if (isSell) return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontWeight: 600, fontSize: 12,
      color: '#B91C1C', background: '#FEF2F2',
      borderRadius: 4, padding: '2px 8px',
    }}>
      <svg width="7" height="7" viewBox="0 0 8 8" fill="#B91C1C"><polygon points="1,2 7,2 4,7" /></svg>
      SELL
    </span>
  );
  return (
    <span style={{ fontSize: 12, color: '#6B7280', background: '#F3F4F6', borderRadius: 4, padding: '2px 8px' }}>
      {type || '—'}
    </span>
  );
}

function Flag({ code }) {
  return (
    <span
      className={`fi fi-${(code || '').toLowerCase()}`}
      style={{ width: 16, height: 12, borderRadius: 2, display: 'inline-block', flexShrink: 0 }}
      aria-label={code}
    />
  );
}

// ─── InsiderRatingBadge ───────────────────────────────────────────────────────

function InsiderRatingBadge({ rating, large = false }) {
  if (rating == null) return <span style={{ fontSize: 12, color: '#9CA3AF' }}>—</span>;
  const [label, bg, text, border] =
    rating >= 80 ? ['Elite',   '#FEF3C7', '#92400E', '#FDE68A'] :
    rating >= 60 ? ['Strong',  '#D1FAE5', '#065F46', '#A7F3D0'] :
    rating >= 40 ? ['Average', '#DBEAFE', '#1E40AF', '#BFDBFE'] :
    rating >= 20 ? ['Weak',    '#FEF9C3', '#854D0E', '#FDE68A'] :
                   ['Poor',    '#FEE2E2', '#991B1B', '#FECACA'];
  const star = rating >= 80 ? '⭐ ' : '';
  if (large) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: text, lineHeight: 1 }}>{rating}</div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
          borderRadius: 20, fontSize: 11, fontWeight: 700, background: bg, color: text,
          border: '1px solid ' + border,
        }}>{star}{label}</span>
      </div>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
      borderRadius: 20, fontSize: 11, fontWeight: 700, background: bg, color: text,
      border: '1px solid ' + border, whiteSpace: 'nowrap',
    }}>{star}{label} · {rating}</span>
  );
}

// ─── ConvictionBadge ──────────────────────────────────────────────────────────

function ConvictionBadge({ label, score, compact = false }) {
  if (!label) return null;
  const isHigh = label === 'High Conviction';
  const isMed  = label === 'Medium Conviction';

  const cfg = isHigh
    ? { bg: '#FEF9C3', color: '#92400E', border: '#FDE68A', dot: '#F59E0B', short: 'HIGH' }
    : isMed
    ? { bg: '#EEF2FF', color: ACCENT,    border: '#C7D2FE', dot: ACCENT,    short: 'MED'  }
    : { bg: '#F3F4F6', color: '#6B7280', border: '#E5E7EB', dot: '#9CA3AF', short: 'LOW'  };

  if (compact) {
    return (
      <span title={`${label}${score != null ? ` (${(score * 100).toFixed(0)}%)` : ''}`} style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: '50%',
        background: cfg.bg, border: '1px solid ' + cfg.border,
        fontSize: 9, fontWeight: 700, color: cfg.color, flexShrink: 0,
        letterSpacing: '-0.02em',
      }}>{cfg.short}</span>
    );
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: cfg.bg, border: '1px solid ' + cfg.border,
      borderRadius: 4, padding: '2px 7px',
      fontSize: 11, fontWeight: 600, color: cfg.color,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot, flexShrink: 0 }} />
      {label}
      {score != null && (
        <span style={{ fontFamily: "'DM Mono', monospace", opacity: 0.7, fontSize: 10 }}>
          {(score * 100).toFixed(0)}%
        </span>
      )}
    </span>
  );
}

// ─── ClusterBadge ─────────────────────────────────────────────────────────────

function ClusterBadge({ clusterSize, clusterValue, clusterStart, clusterEnd, currency, insiderName }) {
  if (!clusterSize || clusterSize < 2) return null;
  if (!isRealPerson(insiderName)) return null;
  const parts = [`insider made ${clusterSize} purchases`];
  if (clusterStart && clusterEnd && clusterStart !== clusterEnd) {
    parts.push(`between ${formatDateShort(clusterStart)} and ${formatDateShort(clusterEnd)}`);
  } else if (clusterStart) {
    parts.push(`around ${formatDateShort(clusterStart)}`);
  }
  if (clusterValue) parts.push(`totalling ${formatValue(clusterValue, currency || 'EUR')}`);
  parts.push('— a strong signal of conviction');
  return (
    <span
      title={parts.join(' ')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: '#EEF2FF', border: '1px solid #C7D2FE',
        borderRadius: 4, padding: '2px 7px',
        fontSize: 11, fontWeight: 600, color: '#4338CA',
        cursor: 'default', whiteSpace: 'nowrap',
      }}
    >
      <svg width="9" height="9" viewBox="0 0 10 10" fill="#4338CA">
        <circle cx="3" cy="5" r="2"/><circle cx="7" cy="3" r="1.5"/><circle cx="7" cy="7" r="1.5"/>
      </svg>
      Cluster
    </span>
  );
}

// ─── ReturnCell — table cell for a post-trade return value ───────────────────

function ReturnCell({ value, daysSince, horizon, style: extraStyle = {} }) {
  const base = { padding: '10px 12px', textAlign: 'right', fontSize: 12, fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap', ...extraStyle };
  if (value !== null && value !== undefined) {
    const pct = (Number(value) * 100).toFixed(1);
    const pos = Number(value) > 0;
    return <td style={{ ...base, color: pos ? '#15803D' : '#B91C1C', fontWeight: 600 }}>{pos ? '+' : ''}{pct}%</td>;
  }
  if (daysSince < horizon) {
    return <td style={{ ...base, color: '#9CA3AF', fontStyle: 'italic', fontSize: 11 }}>pending</td>;
  }
  return <td style={{ ...base, color: '#D1D5DB' }}>—</td>;
}

// ─── computeInsiderRating ─────────────────────────────────────────────────────

function computeInsiderRating(stats) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Map avg return: -20% → 0, 0% → 0.5, +20% → 1
  const normalizeReturn = r => clamp((r / 100 + 0.20) / 0.40, 0, 1);

  let score = 0, totalWeight = 0;

  function addPeriod(stat, winW, retW) {
    if (!stat || stat.count < 1) return;
    if (stat.successRate != null) { score += (stat.successRate / 100) * winW; totalWeight += winW; }
    if (stat.avgReturn != null)   { score += normalizeReturn(stat.avgReturn) * retW; totalWeight += retW; }
  }

  addPeriod(stats.find(s => s.key === '30d'),  0.25, 0.20);
  addPeriod(stats.find(s => s.key === '90d'),  0.35, 0.20);
  addPeriod(stats.find(s => s.key === '180d'), 0.10, 0.05);
  addPeriod(stats.find(s => s.key === '365d'), 0.10, 0.05);

  if (totalWeight === 0) return null;
  return Math.round((score / totalWeight) * 100);
}

// ─── computeInsiderScorecard ──────────────────────────────────────────────────

const PERF_PERIODS = [
  { key: '30d',  label: '30d',      rKey: 'return_30d',  hKey: 'hit_rate_30d',  days: 30  },
  { key: '90d',  label: '90d',      rKey: 'return_90d',  hKey: 'hit_rate_90d',  days: 90  },
  { key: '180d', label: '6 months', rKey: 'return_180d', hKey: 'hit_rate_180d', days: 180 },
  { key: '365d', label: '1 year',   rKey: 'return_365d', hKey: 'hit_rate_365d', days: 365 },
];

function computePeriodStats(perfRows) {
  return PERF_PERIODS.map(p => {
    const mature = perfRows.filter(r => r[p.rKey] != null);
    const hits   = mature.filter(r => r[p.hKey] === true);
    return {
      ...p,
      count:       mature.length,
      pending:     perfRows.length - mature.length,
      successRate: mature.length > 0 ? Math.round(hits.length / mature.length * 100) : null,
      avgReturn:   mature.length > 0 ? +(mature.reduce((s, r) => s + r[p.rKey], 0) / mature.length * 100).toFixed(1) : null,
    };
  });
}

// Minimum trade size per currency — filters grants/awards; ~€1,500 equivalent
const LEADERBOARD_THRESH = {
  EUR: 1500, GBP: 1300, USD: 1650, SEK: 17000, DKK: 11000,
  CHF: 1500, NOK: 17000, PLN:  6500, KRW: 2200000,
  CAD: 2200, HKD: 13000, SGD:  2200, ZAR: 30000,
};

function meetsLeaderboardThreshold(trade) {
  if (!trade.total_value || Number(trade.total_value) <= 0) return false;
  const thresh = LEADERBOARD_THRESH[trade.currency] ?? LEADERBOARD_THRESH.EUR;
  return Number(trade.total_value) >= thresh;
}

// Corporate entity suffixes / patterns — these are via_entity, not real persons
const CORP_RE = /\b(S\.?A\.?R?\.?L?\.?|N\.?V\.?|B\.?V\.?|Ltd\.?|LLC|Inc\.?|Corp\.?|plc|GmbH|Soci[eé]t[eé]|Holding|Participations?|Invest(?:ment)?|Capital|Fund|Trust|Compagnie|Groupe|Fondation|Foundation|A\.?S\.?A?\.?|A\.?B\.?|O\.?y\.?)\b/i;

function isRealPerson(name) {
  if (!name) return false;
  if (name === 'Not disclosed') return false;
  if (CORP_RE.test(name)) return false;
  // All-caps long strings are usually entity names (e.g. "FIRMAMENT PARTICIPATIONS")
  if (name.length > 6 && name === name.toUpperCase() && /\s/.test(name)) return false;
  return true;
}

function computeInsiderScorecard(trades, performance) {
  const perfByTxId = {};
  for (const p of performance) perfByTxId[p.transaction_id] = p;

  const map = {};
  for (const t of trades) {
    const name = isRealPerson(t.insider_name) ? t.insider_name : null;
    if (!name) continue;
    const type = (t.transaction_type || '').toUpperCase();
    if (type !== 'BUY' && type !== 'PURCHASE') continue;
    if (!meetsLeaderboardThreshold(t)) continue;
    if (!map[name]) map[name] = {
      name, role: t.insider_role, company: t.company,
      country_code: t.country_code, trades: [], totalValue: 0,
      totalScore: 0, scoredTrades: 0, latestDate: t.transaction_date,
    };
    map[name].trades.push(t);
    if (t.total_value) map[name].totalValue += Number(t.total_value);
    if (t.conviction_score != null) { map[name].totalScore += Number(t.conviction_score); map[name].scoredTrades++; }
    if (t.transaction_date > map[name].latestDate) map[name].latestDate = t.transaction_date;
  }

  const allInsiders = Object.values(map).filter(ins => ins.trades.length >= 3).map(ins => {
    const myPerf = ins.trades.map(t => perfByTxId[t.id]).filter(Boolean);
    const stats  = computePeriodStats(myPerf);
    const avgScore = ins.scoredTrades > 0 ? Math.round(ins.totalScore / ins.scoredTrades * 100) / 100 : null;
    const rating   = computeInsiderRating(stats);

    // Combined win rate: weighted avg across periods (90d highest weight)
    const periodWeights = [
      { key: '30d', w: 0.20 }, { key: '90d', w: 0.45 },
      { key: '180d', w: 0.20 }, { key: '365d', w: 0.15 },
    ];
    let winSum = 0, winW = 0, retSum = 0, retW = 0;
    for (const { key, w } of periodWeights) {
      const s = stats.find(x => x.key === key);
      if (s && s.successRate != null) { winSum += s.successRate * w; winW += w; }
      if (s && s.avgReturn != null)   { retSum += s.avgReturn * w;   retW += w; }
    }
    const combinedWinRate = winW > 0 ? winSum / winW : null;
    const combinedAvgReturn = retW > 0 ? retSum / retW : null;

    return { ...ins, buys: ins.trades.length, stats, myPerf, avgScore, rating, combinedWinRate, combinedAvgReturn };
  });

  const maxTrades = Math.max(...allInsiders.map(i => i.buys), 1);
  const TODAY_MS = Date.now();

  return allInsiders
    .map(ins => {
      const winScore    = ins.combinedWinRate != null ? ins.combinedWinRate / 100 : 0;
      const volScore    = Math.log(ins.buys + 1) / Math.log(maxTrades + 1);
      const retScore    = ins.combinedAvgReturn != null ? Math.min(Math.max(ins.combinedAvgReturn / 50, -1), 1) * 0.5 + 0.5 : 0.5;
      const daysSinceLast = (TODAY_MS - new Date(ins.latestDate).getTime()) / 86400000;
      const recScore    = Math.max(0, 1 - daysSinceLast / 180);
      const hasPerfData = ins.combinedWinRate != null ? 1 : 0;
      const rankingScore = hasPerfData * (winScore * 0.40 + volScore * 0.25 + retScore * 0.25 + recScore * 0.10);
      return { ...ins, rankingScore };
    })
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .slice(0, 30)
    .map((ins, i) => ({ ...ins, rank: i + 1 }));
}

// ─── TopBar ───────────────────────────────────────────────────────────────────

function TopBar({ page, setPage, search, setSearch }) {
  const navItems = [
    { label: 'Dashboard',    key: 'dashboard' },
    { label: 'Watchlist',    key: 'watchlist'  },
    { label: 'Top Insiders', key: 'insiders'   },
    { label: 'Alerts',       key: 'alerts'     },
    { label: 'Pricing',      key: 'pricing'    },
  ];

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 100,
      background: '#fff', borderBottom: '1px solid #E8E9EE',
      display: 'flex', alignItems: 'center', gap: 0,
      height: 56, padding: '0 24px',
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 32, flexShrink: 0 }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect width="22" height="22" rx="5" fill={ACCENT} />
          <path d="M6 16V10M11 16V6M16 16V12" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em', color: '#111318' }}>
          Insiders<span style={{ color: ACCENT }}>Atlas</span>
        </span>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', flex: 1, maxWidth: 320, marginRight: 'auto' }}>
        <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111318" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search company, ticker or insider…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '7px 12px 7px 30px',
            border: '1px solid #E2E4E9', borderRadius: 7, fontSize: 13,
            fontFamily: "'DM Sans', sans-serif", color: '#111318', background: '#F7F8FA',
            outline: 'none',
          }}
        />
      </div>

      {/* Nav */}
      <nav style={{ display: 'flex', gap: 2, marginLeft: 24 }}>
        {navItems.map(item => {
          const isActive = page === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none',
                background: isActive ? '#EEF2FF' : 'transparent',
                color: isActive ? ACCENT : '#6B7280',
                fontWeight: isActive ? 600 : 400, fontSize: 13,
                cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                transition: 'all 0.15s',
              }}
            >{item.label}</button>
          );
        })}
      </nav>

      {/* Avatar */}
      <div style={{
        marginLeft: 20, width: 32, height: 32, borderRadius: '50%',
        background: ACCENT + '22', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 13, fontWeight: 600, color: ACCENT,
        flexShrink: 0, cursor: 'pointer',
      }}>J</div>
    </header>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ selectedCountries, toggleCountry, clearCountries, countryCounts }) {
  return (
    <aside style={{
      width: 210, flexShrink: 0, padding: '20px 14px',
      borderRight: '1px solid #E8E9EE', background: '#fff',
      minHeight: 'calc(100vh - 56px)', overflowY: 'auto',
    }}>
      {/* Country filter */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
            Country
          </span>
          {selectedCountries.size > 0 && (
            <button onClick={clearCountries} style={{
              fontSize: 11, color: ACCENT, background: 'none', border: 'none',
              cursor: 'pointer', fontFamily: "'DM Sans'", padding: 0,
            }}>Clear</button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {TRACKED_MARKETS.map(code => {
            const checked = selectedCountries.has(code);
            const count = countryCounts[code] || 0;
            return (
              <button
                key={code}
                onClick={() => toggleCountry(code)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: checked ? ACCENT + '10' : 'transparent',
                  fontFamily: "'DM Sans', sans-serif", textAlign: 'left',
                  transition: 'background 0.1s', width: '100%',
                }}
              >
                <span style={{
                  width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                  border: '1.5px solid ' + (checked ? ACCENT : '#D1D5DB'),
                  background: checked ? ACCENT : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {checked && (
                    <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <Flag code={code} />
                <span style={{
                  fontSize: 12, flex: 1,
                  color: checked ? '#111318' : '#374151',
                  fontWeight: checked ? 500 : 400,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {COUNTRY_NAMES[code] || code}
                </span>
                {count > 0 && (
                  <span style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>
                    {count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: '#F3F4F6', margin: '16px 0' }} />

      {/* Live data indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16A34A', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>Updated daily</span>
      </div>
    </aside>
  );
}

// ─── InsiderCard ──────────────────────────────────────────────────────────────

function InsiderCard({ row }) {
  const [hovered, setHovered] = useState(false);
  const name = row.insider_name && row.insider_name !== 'Not disclosed'
    ? row.insider_name
    : (row.via_entity || 'Not disclosed');

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: '#fff',
        border: '1px solid ' + (hovered ? '#C7D2FE' : '#E8E9EE'),
        borderRadius: 10, padding: 16, cursor: 'default',
        boxShadow: hovered ? '0 4px 16px rgba(27,44,193,0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
        transition: 'all 0.18s',
        transform: hovered ? 'translateY(-1px)' : 'none',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <div style={{
              fontWeight: 700, fontSize: 14, color: '#111318',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: 150,
            }}>{row.company}</div>
            {WATCHLIST_TICKERS.has(row.ticker) && (
              <span title="In your watchlist" style={{ fontSize: 11, color: ACCENT, fontWeight: 700 }}>★</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>
            {row.ticker || '—'} · {COUNTRY_NAMES[row.country_code] || row.country_code}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <TypeChip type={row.transaction_type} />
          {row.conviction_label && (
            <ConvictionBadge label={row.conviction_label} score={row.conviction_score} />
          )}
        </div>
      </div>

      {/* Insider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', background: ACCENT + '18',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: ACCENT, flexShrink: 0,
        }}>
          {name.split(' ').map(n => n[0]).filter(Boolean).join('').slice(0, 2).toUpperCase()}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontWeight: 500, fontSize: 12, color: '#111318',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150,
          }}>{name}</div>
          {row.insider_role && (
            <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>{row.insider_role}</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        paddingTop: 8, borderTop: '1px solid #F3F4F6',
      }}>
        <span style={{
          fontWeight: 700, fontSize: 14,
          fontFamily: "'DM Mono', monospace", color: '#111318',
        }}>
          {formatValue(row.total_value, row.currency)}
        </span>
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>{formatDateShort(row.transaction_date)}</span>
      </div>
    </div>
  );
}

// ─── TradesTable ──────────────────────────────────────────────────────────────

function TradesTable({ rows, loading, sortBy, sortDir, onSort, onInsiderClick }) {
  const cols = [
    { key: 'transaction_date', label: 'Date',    align: 'left',  sortable: true  },
    { key: 'company',          label: 'Company',  align: 'left',  sortable: true  },
    { key: 'insider_name',     label: 'Insider',  align: 'left',  sortable: true  },
    { key: 'transaction_type', label: 'Type',     align: 'left',  sortable: false },
    { key: 'price_per_share',  label: 'Price',    align: 'right', sortable: true  },
    { key: 'total_value',      label: 'Value',    align: 'right', sortable: true  },
    { key: 'country_code',     label: 'Country',  align: 'left',  sortable: false },
  ];

  const rowPad = '8px 16px';

  function SortIndicator({ col }) {
    if (!col.sortable) return null;
    if (sortBy === col.key) return <span style={{ color: ACCENT }}>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>;
    return <span style={{ color: '#D1D5DB' }}> ↕</span>;
  }

  const truncCell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

  return (
    <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 100 }} />  {/* Date */}
          <col style={{ width: 150 }} />  {/* Company */}
          <col style={{ width: 150 }} />  {/* Insider */}
          <col style={{ width: 88 }} />   {/* Type */}
          <col style={{ width: 110 }} />  {/* Price */}
          <col style={{ width: 110 }} />  {/* Value */}
          <col style={{ width: 72 }} />   {/* Country */}
        </colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
            {cols.map(col => (
              <th
                key={col.key}
                onClick={() => col.sortable && onSort(col.key)}
                style={{
                  padding: '10px 16px', textAlign: col.align,
                  fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: col.sortable ? 'pointer' : 'default',
                  userSelect: 'none', whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                {col.label}<SortIndicator col={col} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 12 }).map((_, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #F9FAFB' }}>
                {cols.map((col, j) => (
                  <td key={j} style={{ padding: rowPad }}>
                    <div style={{
                      height: 14, borderRadius: 4, background: '#F3F4F6',
                      width: j === 1 ? 120 : j === 2 ? 100 : 60,
                      animation: 'pulse 1.5s infinite',
                    }} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} style={{ padding: '60px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: '#9CA3AF' }}>No results found</div>
                <div style={{ fontSize: 12, color: '#D1D5DB', marginTop: 4 }}>Try adjusting your search or country filter</div>
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const name = row.insider_name && row.insider_name !== 'Not disclosed'
                ? row.insider_name
                : null;
              const entityFallback = row.via_entity;

              return (
                <tr
                  key={row.id ?? i}
                  style={{ borderBottom: i < rows.length - 1 ? '1px solid #F9FAFB' : 'none', transition: 'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  {/* Date */}
                  <td style={{ padding: rowPad, fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {formatDateShort(row.transaction_date)}
                  </td>
                  {/* Company */}
                  <td style={{ padding: rowPad, overflow: 'hidden' }} title={row.company}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#111318', ...truncCell }}>{row.company}</div>
                    {row.ticker && (
                      <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>{row.ticker}</div>
                    )}
                  </td>
                  {/* Insider */}
                  <td style={{ padding: rowPad, overflow: 'hidden' }}>
                    {name ? (
                      <>
                        {onInsiderClick ? (
                          <button onClick={() => onInsiderClick(name)} style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            fontWeight: 500, fontSize: 13, color: ACCENT, textAlign: 'left',
                            fontFamily: "'DM Sans', sans-serif", ...truncCell, maxWidth: '100%', display: 'block',
                          }} title={name}>{name}</button>
                        ) : (
                          <div style={{ fontWeight: 500, fontSize: 13, ...truncCell }} title={name}>{name}</div>
                        )}
                        {row.via_entity && (
                          <div style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic', ...truncCell }}>
                            via {row.via_entity}
                          </div>
                        )}
                        {row.insider_role && !row.via_entity && (
                          <div style={{ fontSize: 11, color: '#9CA3AF', ...truncCell }}>{row.insider_role}</div>
                        )}
                      </>
                    ) : entityFallback ? (
                      <>
                        <div style={{ fontWeight: 500, fontSize: 13, ...truncCell }} title={entityFallback}>{entityFallback}</div>
                        {row.insider_role && (
                          <div style={{ fontSize: 11, color: '#9CA3AF', ...truncCell }}>{row.insider_role}</div>
                        )}
                      </>
                    ) : (
                      <div style={{ fontSize: 13, color: '#9CA3AF' }}>Not disclosed</div>
                    )}
                  </td>
                  {/* Type + conviction + cluster */}
                  <td style={{ padding: rowPad }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <TypeChip type={row.transaction_type} />
                      {row.conviction_label && (
                        <ConvictionBadge label={row.conviction_label} score={row.conviction_score} compact />
                      )}
                      {row.cluster_size >= 2 && (
                        <ClusterBadge
                          clusterSize={row.cluster_size}
                          clusterValue={row.cluster_value}
                          clusterStart={row.cluster_start}
                          clusterEnd={row.cluster_end}
                          currency={row.currency}
                          insiderName={row.insider_name}
                        />
                      )}
                    </div>
                  </td>
                  {/* Price */}
                  <td style={{ padding: rowPad, fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {formatPrice(row.price_per_share, row.currency)}
                  </td>
                  {/* Value */}
                  <td style={{ padding: rowPad, fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {formatValue(row.total_value, row.currency)}
                  </td>
                  {/* Country */}
                  <td style={{ padding: rowPad, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Flag code={row.country_code} />
                      <span style={{ fontSize: 12, color: '#6B7280' }}>{row.country_code}</span>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── BuybackTable ─────────────────────────────────────────────────────────────

function BuybackTable({ rows, loading, sortBy, sortDir, onSort }) {
  const cols = [
    { key: 'announced_date', label: 'Date',    align: 'left',  sortable: true  },
    { key: 'company',        label: 'Company',  align: 'left',  sortable: true  },
    { key: 'ticker',         label: 'Ticker',   align: 'left',  sortable: true  },
    { key: 'country_code',   label: 'Country',  align: 'left',  sortable: false },
    { key: 'total_value',    label: 'Size',     align: 'right', sortable: true  },
    { key: 'source',         label: 'Source',   align: 'left',  sortable: false },
  ];

  const rowPad = '8px 16px';

  return (
    <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
              {cols.map(col => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && onSort(col.key)}
                  style={{
                    padding: '10px 16px', textAlign: col.align,
                    fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    cursor: col.sortable ? 'pointer' : 'default',
                    userSelect: 'none', whiteSpace: 'nowrap',
                  }}
                >
                  {col.label}
                  {col.sortable && (
                    sortBy === col.key
                      ? <span style={{ color: ACCENT }}>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>
                      : <span style={{ color: '#D1D5DB' }}> ↕</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #F9FAFB' }}>
                  {cols.map((_, j) => (
                    <td key={j} style={{ padding: rowPad }}>
                      <div style={{ height: 14, borderRadius: 4, background: '#F3F4F6', width: j === 1 ? 120 : 70 }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length} style={{ padding: '60px 20px', textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: '#9CA3AF' }}>No results found</div>
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={row.id ?? i}
                  style={{ borderBottom: i < rows.length - 1 ? '1px solid #F9FAFB' : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ padding: rowPad, fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>
                    {formatDateShort(row.announced_date)}
                  </td>
                  <td style={{ padding: rowPad }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#111318' }}>{row.company}</div>
                  </td>
                  <td style={{ padding: rowPad, fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151' }}>{row.ticker || '—'}</td>
                  <td style={{ padding: rowPad }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Flag code={row.country_code} />
                      <span style={{ fontSize: 12, color: '#6B7280' }}>{row.country_code}</span>
                    </div>
                  </td>
                  <td style={{ padding: rowPad, textAlign: 'right' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: '#111318' }}>
                      {formatValue(row.total_value, row.currency)}
                    </span>
                  </td>
                  <td style={{ padding: rowPad, fontSize: 11, color: '#9CA3AF', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.source || '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── WatchlistPage ────────────────────────────────────────────────────────────

function WatchlistPage({ trades, tradesLoading, onInsiderClick }) {
  const watchlistTrades = useMemo(() => {
    const result = {};
    for (const w of WATCHLIST) result[w.ticker] = { ...w, buys: [], sells: [] };

    for (const t of trades) {
      if (!matchesWatchlist(t)) continue;
      const entry = result[t.ticker];
      if (!entry) continue;
      const type = (t.transaction_type || '').toUpperCase();
      if (type === 'BUY' || type === 'PURCHASE') entry.buys.push(t);
      else entry.sells.push(t);
    }
    return Object.values(result);
  }, [trades]);

  const allWatchlistTrades = useMemo(() => {
    return trades
      .filter(t => matchesWatchlist(t))
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
  }, [trades]);

  return (
    <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#111318', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: ACCENT }}>★</span> My Watchlist
        </h1>
        <p style={{ fontSize: 13, color: '#9CA3AF' }}>Insider activity in your personally tracked stocks</p>
      </div>

      {/* Stock summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
        {watchlistTrades.map(w => {
          const latestBuy = w.buys[0];
          const hasHighConviction = w.buys.some(b => b.conviction_label === 'High Conviction');
          const recentBuys90 = w.buys.filter(b => (Date.now() - new Date(b.transaction_date)) / 86400000 <= 90);

          return (
            <div key={w.ticker} style={{
              background: '#fff',
              border: '1px solid ' + (hasHighConviction ? '#FDE68A' : '#E8E9EE'),
              borderTop: '3px solid ' + (hasHighConviction ? '#F59E0B' : ACCENT + '40'),
              borderRadius: 10, padding: 16,
              boxShadow: hasHighConviction ? '0 4px 16px rgba(245,158,11,0.10)' : '0 1px 3px rgba(0,0,0,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#111318' }}>{w.company}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#9CA3AF' }}>{w.ticker}</span>
                    <Flag code={w.country} />
                  </div>
                </div>
                {hasHighConviction && (
                  <span style={{ fontSize: 10, background: '#FEF9C3', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>HIGH ★</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Buys (90d)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: recentBuys90.length > 0 ? '#15803D' : '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>
                    {recentBuys90.length}
                  </div>
                </div>
                {latestBuy && (
                  <div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Last Buy</div>
                    <div style={{ fontSize: 12, color: '#374151', fontFamily: "'DM Mono', monospace" }}>{formatValue(latestBuy.total_value, latestBuy.currency)}</div>
                  </div>
                )}
              </div>

              {latestBuy ? (
                <div style={{ background: '#F9FAFB', borderRadius: 6, padding: '8px 10px', borderLeft: '3px solid #16A34A' }}>
                  <div style={{ fontSize: 11, color: '#374151', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {latestBuy.insider_name && latestBuy.insider_name !== 'Not disclosed'
                      ? latestBuy.insider_name : (latestBuy.via_entity || 'Insider')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 }}>
                    <span style={{ fontSize: 11, color: '#9CA3AF' }}>{formatDateShort(latestBuy.transaction_date)}</span>
                    {latestBuy.conviction_label && <ConvictionBadge label={latestBuy.conviction_label} score={latestBuy.conviction_score} compact />}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#D1D5DB', textAlign: 'center', padding: '8px 0' }}>No recent insider buys</div>
              )}
            </div>
          );
        })}
      </div>

      {/* All watchlist transactions table */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em' }}>Recent Transactions</h2>
            <p style={{ fontSize: 13, color: '#9CA3AF', marginTop: 2 }}>All insider trades in your watchlist stocks</p>
          </div>
          {!tradesLoading && (
            <span style={{ fontSize: 12, color: '#9CA3AF', background: '#F7F8FA', border: '1px solid #E8E9EE', borderRadius: 6, padding: '4px 10px' }}>
              {allWatchlistTrades.length} transactions
            </span>
          )}
        </div>

        {tradesLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#9CA3AF', fontSize: 13 }}>Loading…</div>
        ) : allWatchlistTrades.length === 0 ? (
          <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, padding: '48px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#9CA3AF' }}>No insider transactions found for watchlist stocks</div>
            <div style={{ fontSize: 12, color: '#D1D5DB', marginTop: 4 }}>Transactions will appear here as they are filed</div>
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 100 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
                  {['Date', 'Stock', 'Insider', 'Type', 'Price', 'Value'].map((label, i) => (
                    <th key={label} style={{
                      padding: '10px 16px', textAlign: i >= 4 ? 'right' : 'left',
                      fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                      letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allWatchlistTrades.map((t, i) => {
                  const name = t.insider_name && t.insider_name !== 'Not disclosed' ? t.insider_name : null;
                  return (
                    <tr key={t.id ?? i}
                      style={{ borderBottom: i < allWatchlistTrades.length - 1 ? '1px solid #F9FAFB' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      <td style={{ padding: '10px 16px', fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>
                        {formatDateShort(t.transaction_date)}
                      </td>
                      <td style={{ padding: '10px 16px', overflow: 'hidden' }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#111318', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.company}</div>
                        <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>{t.ticker}</div>
                      </td>
                      <td style={{ padding: '10px 16px', overflow: 'hidden' }}>
                        {name ? (
                          onInsiderClick ? (
                            <button onClick={() => onInsiderClick(name)} style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontWeight: 500, fontSize: 13, color: ACCENT, textAlign: 'left',
                              fontFamily: "'DM Sans', sans-serif", overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap', maxWidth: '100%', display: 'block',
                            }}>{name}</button>
                          ) : (
                            <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                          )
                        ) : (
                          <div style={{ fontSize: 13, color: '#9CA3AF' }}>{t.via_entity || 'Not disclosed'}</div>
                        )}
                        {t.insider_role && (
                          <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.insider_role}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 16px' }}><TypeChip type={t.transaction_type} /></td>
                      <td style={{ padding: '10px 16px', fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatPrice(t.price_per_share, t.currency)}
                      </td>
                      <td style={{ padding: '10px 16px', fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatValue(t.total_value, t.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

// ─── DashboardPage ────────────────────────────────────────────────────────────

function DashboardPage({
  trades, buybacks,
  tradesLoading, buybacksLoading,
  filteredTrades, filteredBuybacks,
  tradeSort, setTradeSort,
  buybackSort, setBuybackSort,
  tradeStats, buybackStats,
  selectedCountries, toggleCountry, clearCountries,
  countryCounts, onInsiderClick,
}) {
  const [activeTab, setActiveTab] = useState('trades');

  function handleTradeSort(col) {
    setTradeSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'desc' }));
  }
  function handleBuybackSort(col) {
    setBuybackSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'desc' }));
  }

  const stats = [
    {
      label: 'Total Trades',
      value: tradesLoading ? '…' : tradeStats.total.toLocaleString(),
      sub: 'All tracked transactions',
    },
    {
      label: 'Insider Buys',
      value: tradesLoading ? '…' : tradeStats.buys.toLocaleString(),
      sub: 'Purchase transactions',
      color: '#16A34A',
    },
    {
      label: 'Insider Sells',
      value: tradesLoading ? '…' : tradeStats.sells.toLocaleString(),
      sub: 'Sale transactions',
      color: '#DC2626',
    },
    {
      label: 'Total Value',
      value: tradesLoading ? '…' : formatValue(tradeStats.totalVal, 'EUR'),
      sub: 'Aggregate value (EUR equiv.)',
    },
  ];

  const isLoading = activeTab === 'trades' ? tradesLoading : buybacksLoading;
  const activeCount = activeTab === 'trades' ? filteredTrades.length : filteredBuybacks.length;
  const totalCount = activeTab === 'trades' ? trades.length : buybacks.length;

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <Sidebar
        selectedCountries={selectedCountries}
        toggleCountry={toggleCountry}
        clearCountries={clearCountries}
        countryCounts={countryCounts}
      />
      <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0 }}>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 32 }}>
          {stats.map((s, i) => (
            <div key={i} style={{
              background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10,
              padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{
                fontSize: 11, color: '#9CA3AF', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                marginBottom: 10, height: 28,
                display: 'flex', alignItems: 'flex-start',
              }}>{s.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span style={{
                  fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em',
                  color: s.color || '#111318',
                  fontFamily: "'DM Mono', monospace", lineHeight: 1,
                }}>{s.value}</span>
              </div>
              <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Recent Trades section */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em' }}>
                {activeTab === 'trades' ? 'Recent Insider Trades' : 'Buyback Programs'}
              </h2>
              <p style={{ fontSize: 13, color: '#9CA3AF', marginTop: 2 }}>
                {activeTab === 'trades'
                  ? 'All disclosed transactions across tracked markets'
                  : 'Corporate share buyback announcements'
                }
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Tab toggle */}
              <div style={{
                display: 'flex', alignItems: 'center',
                background: '#F3F4F6', border: '1px solid #E2E4E9',
                borderRadius: 7, padding: 3, gap: 2,
              }}>
                {[
                  { key: 'trades', label: 'Insider Trades' },
                  { key: 'buybacks', label: 'Buybacks' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    style={{
                      padding: '5px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
                      background: activeTab === tab.key ? '#fff' : 'transparent',
                      color: activeTab === tab.key ? '#111318' : '#9CA3AF',
                      fontWeight: activeTab === tab.key ? 600 : 400,
                      fontSize: 12, fontFamily: "'DM Sans', sans-serif",
                      boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                      transition: 'all 0.15s',
                    }}
                  >{tab.label}</button>
                ))}
              </div>
              {!isLoading && (
                <span style={{
                  fontSize: 12, color: '#9CA3AF', background: '#F7F8FA',
                  border: '1px solid #E8E9EE', borderRadius: 6, padding: '4px 10px',
                }}>
                  {activeCount.toLocaleString()} / {totalCount.toLocaleString()}
                </span>
              )}
            </div>
          </div>

          {activeTab === 'trades' ? (
            <TradesTable
              rows={filteredTrades}
              loading={tradesLoading}
              sortBy={tradeSort.by}
              sortDir={tradeSort.dir}
              onSort={handleTradeSort}
              onInsiderClick={onInsiderClick}
            />
          ) : (
            <BuybackTable
              rows={filteredBuybacks}
              loading={buybacksLoading}
              sortBy={buybackSort.by}
              sortDir={buybackSort.dir}
              onSort={handleBuybackSort}
            />
          )}

          {!isLoading && activeCount > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 16px',
              background: '#fff', border: '1px solid #E8E9EE', borderRadius: '0 0 10px 10px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderTop: 'none',
            }}>
              <p style={{ fontSize: 12, color: '#9CA3AF' }}>
                Showing{' '}
                <span style={{ color: '#374151', fontWeight: 500 }}>{activeCount.toLocaleString()}</span>
                {' '}of{' '}
                <span style={{ color: '#374151', fontWeight: 500 }}>{totalCount.toLocaleString()}</span>
                {' '}{activeTab === 'trades' ? 'transactions' : 'programs'}
              </p>
              <p style={{ fontSize: 12, color: '#D1D5DB' }}>Sourced from regulatory filings</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── InsiderProfilePage ───────────────────────────────────────────────────────

function InsiderProfilePage({ insiderName, trades, performance, onBack }) {
  const myTrades = useMemo(() =>
    trades.filter(t => t.insider_name === insiderName)
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date)),
    [trades, insiderName]
  );

  const myBuys = useMemo(() =>
    myTrades.filter(t => ['BUY', 'PURCHASE'].includes((t.transaction_type || '').toUpperCase())),
    [myTrades]
  );

  const perfByTxId = useMemo(() => {
    const m = {};
    for (const p of performance) m[p.transaction_id] = p;
    return m;
  }, [performance]);

  const myPerf = useMemo(() => myBuys.map(t => perfByTxId[t.id]).filter(Boolean), [myBuys, perfByTxId]);
  const stats  = useMemo(() => computePeriodStats(myPerf), [myPerf]);
  const rating = useMemo(() => computeInsiderRating(stats), [stats]);

  const role      = myTrades[0]?.insider_role;
  const companies = [...new Set(myTrades.map(t => t.company))];
  const initials  = insiderName.split(' ').map(n => n[0]).filter(Boolean).join('').slice(0, 2).toUpperCase();

  // ── Aggregate KPIs ──────────────────────────────────────────────────────────
  const totalInvested = useMemo(() =>
    myBuys.reduce((s, t) => s + (Number(t.total_value) || 0), 0),
    [myBuys]
  );

  const avgBuyPrice = useMemo(() => {
    const buysWithData = myBuys.filter(t => t.shares && t.total_value);
    const totalShares = buysWithData.reduce((s, t) => s + Number(t.shares), 0);
    const totalVal    = buysWithData.reduce((s, t) => s + Number(t.total_value), 0);
    return totalShares > 0 ? totalVal / totalShares : null;
  }, [myBuys]);

  const weighted30d = useMemo(() => {
    const eligible = myBuys.filter(t => perfByTxId[t.id]?.return_30d != null && t.total_value);
    if (!eligible.length) return null;
    const wSum = eligible.reduce((s, t) => s + perfByTxId[t.id].return_30d * Number(t.total_value), 0);
    const vSum = eligible.reduce((s, t) => s + Number(t.total_value), 0);
    return vSum > 0 ? wSum / vSum : null;
  }, [myBuys, perfByTxId]);

  const weighted90d = useMemo(() => {
    const eligible = myBuys.filter(t => perfByTxId[t.id]?.return_90d != null && t.total_value);
    if (!eligible.length) return null;
    const wSum = eligible.reduce((s, t) => s + perfByTxId[t.id].return_90d * Number(t.total_value), 0);
    const vSum = eligible.reduce((s, t) => s + Number(t.total_value), 0);
    return vSum > 0 ? wSum / vSum : null;
  }, [myBuys, perfByTxId]);

  const weighted180d = useMemo(() => {
    const eligible = myBuys.filter(t => perfByTxId[t.id]?.return_180d != null && t.total_value);
    if (!eligible.length) return null;
    const wSum = eligible.reduce((s, t) => s + perfByTxId[t.id].return_180d * Number(t.total_value), 0);
    const vSum = eligible.reduce((s, t) => s + Number(t.total_value), 0);
    return vSum > 0 ? wSum / vSum : null;
  }, [myBuys, perfByTxId]);

  const weighted365d = useMemo(() => {
    const eligible = myBuys.filter(t => perfByTxId[t.id]?.return_365d != null && t.total_value);
    if (!eligible.length) return null;
    const wSum = eligible.reduce((s, t) => s + perfByTxId[t.id].return_365d * Number(t.total_value), 0);
    const vSum = eligible.reduce((s, t) => s + Number(t.total_value), 0);
    return vSum > 0 ? wSum / vSum : null;
  }, [myBuys, perfByTxId]);

  const currency = myBuys[0]?.currency || 'EUR';

  function ReturnKpi({ value, label }) {
    if (value == null) return (
      <div>
        <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#D1D5DB', fontFamily: "'DM Mono', monospace" }}>—</div>
        <div style={{ fontSize: 10, color: '#D1D5DB', marginTop: 2 }}>pending</div>
      </div>
    );
    const pct = (value * 100).toFixed(1);
    const pos = value > 0;
    return (
      <div>
        <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'DM Mono', monospace", lineHeight: 1, color: pos ? '#15803D' : '#B91C1C' }}>
          {pos ? '+' : ''}{pct}%
        </div>
        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>weighted avg</div>
      </div>
    );
  }

  return (
    <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        {/* Back */}
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          cursor: 'pointer', color: '#6B7280', fontSize: 13, padding: '0 0 20px',
          fontFamily: "'DM Sans', sans-serif",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to leaderboard
        </button>

        {/* Profile header */}
        <div style={{
          background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12,
          padding: '24px 28px', marginBottom: 16, display: 'flex', gap: 20, alignItems: 'flex-start',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', background: ACCENT + '18',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 700, color: ACCENT, flexShrink: 0,
          }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: '#111318', letterSpacing: '-0.02em', marginBottom: 4 }}>{insiderName}</h1>
            <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 14 }}>
              {role ? role + ' · ' : ''}{companies.slice(0, 3).join(', ')}
            </div>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Total Buys</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'DM Mono', monospace" }}>{myBuys.length}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Total Invested</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#16A34A', fontFamily: "'DM Mono', monospace" }}>{formatValue(totalInvested, currency)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Avg Buy Price</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'DM Mono', monospace" }}>
                  {avgBuyPrice != null ? formatPrice(avgBuyPrice, currency) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Tracked</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'DM Mono', monospace" }}>{myPerf.length}</div>
              </div>
            </div>
          </div>
          {/* Rating — primary KPI, top-right */}
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Insider Rating</div>
            <InsiderRatingBadge rating={rating} large />
          </div>
        </div>

        {/* Aggregate return KPIs — weighted by trade value */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
          {[
            { label: '30d Return (wtd)',  value: weighted30d  },
            { label: '90d Return (wtd)',  value: weighted90d  },
            { label: '6m Return (wtd)',   value: weighted180d },
            { label: '1y Return (wtd)',   value: weighted365d },
          ].map(card => (
            <div key={card.label} style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>{card.label}</div>
              <ReturnKpi value={card.value} label="" />
            </div>
          ))}
        </div>

        {/* Period win-rate cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
          {stats.map(s => (
            <div key={s.key} style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
                {s.label} win rate
              </div>
              {s.count > 0 ? (
                <>
                  <div style={{
                    fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em',
                    fontFamily: "'DM Mono', monospace", lineHeight: 1, marginBottom: 4,
                    color: s.successRate >= 60 ? '#16A34A' : s.successRate >= 40 ? '#D97706' : '#DC2626',
                  }}>{s.successRate}%</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>{s.count} trades resolved</div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: s.avgReturn > 0 ? '#16A34A' : '#DC2626' }}>
                    {s.avgReturn > 0 ? '+' : ''}{s.avgReturn}% avg
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: '#9CA3AF', fontStyle: 'italic', marginTop: 8 }}>
                  {s.pending > 0 ? `${s.pending} pending` : 'No data'}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Transaction history */}
        <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #F3F4F6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Transaction History</span>
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>{myTrades.length} transactions</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
                {[
                  { label: 'Date',       align: 'left'  },
                  { label: 'Shares',     align: 'right' },
                  { label: 'Buy Price',  align: 'right' },
                  { label: 'Value',      align: 'right' },
                  { label: '30d',        align: 'right' },
                  { label: '90d',        align: 'right' },
                  { label: '6m',         align: 'right' },
                  { label: '1y',         align: 'right' },
                  { label: 'Conviction', align: 'left'  },
                ].map(col => (
                  <th key={col.label} style={{
                    padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                    letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: col.align,
                    whiteSpace: 'nowrap',
                  }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {myTrades.map((t, i) => {
                const perf    = perfByTxId[t.id];
                const isBuy   = ['BUY', 'PURCHASE'].includes((t.transaction_type || '').toUpperCase());
                const daysSince = t.transaction_date
                  ? Math.floor((Date.now() - new Date(t.transaction_date)) / 86400000) : 0;
                return (
                  <tr key={t.id}
                    style={{ borderBottom: i < myTrades.length - 1 ? '1px solid #F9FAFB' : 'none' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace" }}>{formatDateShort(t.transaction_date)}</div>
                      {t.company && companies.length > 1 && (
                        <div style={{ fontSize: 10, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }} title={t.company}>{t.ticker || t.company}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', textAlign: 'right' }}>
                      {t.shares != null ? formatShares(t.shares) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {t.price_per_share != null ? formatPrice(t.price_per_share, t.currency) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {formatValue(t.total_value, t.currency)}
                    </td>
                    {isBuy && perf ? (
                      <>
                        <ReturnCell value={perf.return_30d}  daysSince={daysSince} horizon={30}  />
                        <ReturnCell value={perf.return_90d}  daysSince={daysSince} horizon={90}  />
                        <ReturnCell value={perf.return_180d} daysSince={daysSince} horizon={180} />
                        <ReturnCell value={perf.return_365d} daysSince={daysSince} horizon={365} />
                      </>
                    ) : (
                      [0, 1, 2, 3].map(j => (
                        <td key={j} style={{ padding: '10px 12px', color: '#E5E7EB', textAlign: 'right', fontSize: 12 }}>—</td>
                      ))
                    )}
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                        {isBuy && t.conviction_score != null ? (
                          <ConvictionBadge
                            label={t.conviction_score >= 0.70 ? 'High Conviction' : t.conviction_score >= 0.40 ? 'Medium Conviction' : 'Low Conviction'}
                            score={t.conviction_score}
                            compact
                          />
                        ) : (
                          <TypeChip type={t.transaction_type} />
                        )}
                        {t.cluster_size >= 2 && (
                          <ClusterBadge
                            clusterSize={t.cluster_size}
                            clusterValue={t.cluster_value}
                            clusterStart={t.cluster_start}
                            clusterEnd={t.cluster_end}
                            currency={t.currency}
                            insiderName={t.insider_name}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── InsidersPage ─────────────────────────────────────────────────────────────

function InsidersPage({ trades, performance, tradesLoading, perfLoading, onInsiderClick }) {
  const leaderboard = useMemo(() =>
    tradesLoading ? [] : computeInsiderScorecard(trades, performance),
    [trades, performance, tradesLoading]
  );

  const rankColors = ['#F59E0B', '#9CA3AF', '#CD7C2F'];
  const isLoading = tradesLoading || perfLoading;

  function SuccessCell({ value, count }) {
    if (value === null || value === undefined) {
      return <td style={{ padding: '12px 14px', textAlign: 'center', color: '#D1D5DB', fontSize: 12 }}>—</td>;
    }
    const color = value >= 60 ? '#16A34A' : value >= 40 ? '#D97706' : '#DC2626';
    return (
      <td style={{ padding: '12px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: "'DM Mono', monospace" }}>{value}%</div>
        {count > 0 && <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>{count} trades</div>}
      </td>
    );
  }

  return (
    <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111318', letterSpacing: '-0.02em', marginBottom: 4 }}>
            Top Insiders
          </h1>
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            Ranked by overall performance score. Click an insider name to view their full track record.
          </p>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#9CA3AF', fontSize: 13 }}>Loading…</div>
        ) : leaderboard.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#9CA3AF', fontSize: 13 }}>No data available</div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #F3F4F6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Leaderboard</span>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>Top {leaderboard.length} insiders · ranked by performance score</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
                    {[
                      { label: '#',           align: 'center' },
                      { label: 'Insider',     align: 'left'   },
                      { label: 'Company',     align: 'left'   },
                      { label: 'Buys',        align: 'center' },
                      { label: 'Avg Win Rate',align: 'center' },
                      { label: 'Avg Return',  align: 'center' },
                      { label: 'Last Trade',  align: 'left'   },
                      { label: 'Rating',      align: 'left'   },
                    ].map(col => (
                      <th key={col.label} style={{
                        padding: '10px 14px', fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                        letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: col.align,
                        whiteSpace: 'nowrap',
                      }}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((ins, i) => {
                    const totalTrades = ins.stats.reduce((s, p) => s + p.count, 0);
                    const winRate = ins.combinedWinRate;
                    const avgReturn = ins.combinedAvgReturn;
                    return (
                      <tr key={ins.name}
                        style={{ borderBottom: i < leaderboard.length - 1 ? '1px solid #F9FAFB' : 'none', transition: 'background 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 24, height: 24, borderRadius: 6,
                            background: i < 3 ? (rankColors[i] + '22') : '#F3F4F6',
                            color: i < 3 ? rankColors[i] : '#9CA3AF',
                            fontSize: 11, fontWeight: 700,
                          }}>#{ins.rank}</span>
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                              width: 30, height: 30, borderRadius: '50%',
                              background: ACCENT + '14', display: 'flex', alignItems: 'center',
                              justifyContent: 'center', fontSize: 11, fontWeight: 700, color: ACCENT, flexShrink: 0,
                            }}>
                              {ins.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <button onClick={() => onInsiderClick(ins.name)} style={{
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontWeight: 600, fontSize: 13, color: ACCENT, textAlign: 'left',
                                fontFamily: "'DM Sans', sans-serif", display: 'block',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
                              }}>{ins.name}</button>
                              {ins.role && (
                                <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{ins.role}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <div style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{ins.company}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Flag code={ins.country_code} />
                            <span style={{ fontSize: 11, color: '#9CA3AF' }}>{ins.country_code}</span>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#111318', fontFamily: "'DM Mono', monospace" }}>{ins.buys}</td>
                        {/* Avg Win Rate */}
                        <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                          {winRate != null ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 700, color: winRate >= 60 ? '#16A34A' : winRate >= 40 ? '#D97706' : '#DC2626', fontFamily: "'DM Mono', monospace" }}>
                                {Math.round(winRate)}%
                              </div>
                              {totalTrades > 0 && <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>{totalTrades} tracked</div>}
                            </>
                          ) : (
                            <span style={{ color: '#D1D5DB', fontSize: 12 }}>—</span>
                          )}
                        </td>
                        {/* Avg Return */}
                        <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                          {avgReturn != null ? (
                            <div style={{ fontSize: 13, fontWeight: 700, color: avgReturn > 0 ? '#16A34A' : '#DC2626', fontFamily: "'DM Mono', monospace" }}>
                              {avgReturn > 0 ? '+' : ''}{avgReturn.toFixed(1)}%
                            </div>
                          ) : (
                            <span style={{ color: '#D1D5DB', fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 14px', fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>
                          {formatDateShort(ins.latestDate)}
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <InsiderRatingBadge rating={ins.rating} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ─── AlertsPage ───────────────────────────────────────────────────────────────

function AlertsPage({ trades, tradesLoading }) {
  const recentAlerts = useMemo(() => {
    return trades
      .filter(t => {
        const type = (t.transaction_type || '').toUpperCase();
        return (type === 'BUY' || type === 'PURCHASE') && t.total_value;
      })
      .sort((a, b) => {
        // Watchlist first, then high conviction, then by date/value
        const aWatch = WATCHLIST_TICKERS.has(a.ticker) ? 1 : 0;
        const bWatch = WATCHLIST_TICKERS.has(b.ticker) ? 1 : 0;
        if (bWatch !== aWatch) return bWatch - aWatch;
        const aHigh = a.conviction_label === 'High Conviction' ? 1 : 0;
        const bHigh = b.conviction_label === 'High Conviction' ? 1 : 0;
        if (bHigh !== aHigh) return bHigh - aHigh;
        if (b.transaction_date > a.transaction_date) return 1;
        if (b.transaction_date < a.transaction_date) return -1;
        return Number(b.total_value) - Number(a.total_value);
      })
      .slice(0, 30);
  }, [trades]);

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }

  const isHighValue = (row) => row.total_value && Number(row.total_value) >= 500000;

  return (
    <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>Alerts</h1>
        <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 28 }}>
          Recent high-value insider buys from tracked markets.
        </p>

        {tradesLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#9CA3AF', fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recentAlerts.map((row, i) => {
              const urgent  = isHighValue(row);
              const isWatch = WATCHLIST_TICKERS.has(row.ticker);
              const isHigh  = row.conviction_label === 'High Conviction';
              const name    = row.insider_name && row.insider_name !== 'Not disclosed'
                ? row.insider_name : (row.via_entity || 'Insider');

              const accentColor = isWatch ? '#F59E0B' : isHigh ? ACCENT : urgent ? '#F59E0B' : '#E2E4E9';
              const borderColor = isWatch ? '#FDE68A' : isHigh ? '#C7D2FE' : urgent ? '#FDE68A' : '#E8E9EE';

              return (
                <div key={row.id ?? i} style={{
                  background: '#fff',
                  border: '1px solid ' + borderColor,
                  borderLeft: '3px solid ' + accentColor,
                  borderRadius: 8, padding: '14px 18px',
                  display: 'flex', alignItems: 'center', gap: 16,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                      {isWatch && (
                        <span style={{ fontSize: 11, fontWeight: 700, background: '#FEF9C3', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 4, padding: '1px 7px' }}>
                          ★ Watchlist
                        </span>
                      )}
                      {row.conviction_label && (
                        <ConvictionBadge label={row.conviction_label} score={row.conviction_score} />
                      )}
                      {!row.conviction_label && urgent && (
                        <span style={{ fontSize: 11, fontWeight: 600, background: '#FEF9C3', color: '#92400E', borderRadius: 4, padding: '1px 7px' }}>
                          High-Value Buy
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>{timeAgo(row.transaction_date)}</span>
                      <Flag code={row.country_code} />
                    </div>
                    <div style={{ fontSize: 13, color: '#374151' }}>
                      <strong>{name}</strong>
                      {row.insider_role ? ` (${row.insider_role})` : ''}
                      {' '}bought{' '}
                      <strong style={{ fontFamily: "'DM Mono', monospace" }}>{formatValue(row.total_value, row.currency)}</strong>
                      {' '}in <strong>{row.company}</strong>
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

// ─── PricingPage ──────────────────────────────────────────────────────────────

const PLAN_FEATURES_GRID = [
  { category: 'Data Access', rows: [
    { label: 'Countries covered',       analyst: '3',          strategist: '10',             terminal: 'All 30+' },
    { label: 'Insider Score',           analyst: 'Full',       strategist: 'Full + history', terminal: 'Full + raw signals' },
    { label: 'Trade history depth',     analyst: 'Full archive', strategist: 'Full archive', terminal: 'Full archive' },
    { label: 'Filing latency',          analyst: 'Daily',      strategist: 'Daily',          terminal: 'Daily' },
  ]},
  { category: 'Signals & Alerts', rows: [
    { label: 'Signal alerts',           analyst: '5 / week',   strategist: 'Unlimited',      terminal: 'Unlimited + webhooks' },
    { label: 'Cluster buy detection',   analyst: false,        strategist: true,             terminal: true },
    { label: 'Portfolio alerts',        analyst: false,        strategist: true,             terminal: true },
  ]},
  { category: 'Tools & Export', rows: [
    { label: 'Top Insiders leaderboard', analyst: true,        strategist: true,             terminal: true },
    { label: 'Company pages',           analyst: true,         strategist: true,             terminal: true },
    { label: 'CSV export',              analyst: false,        strategist: true,             terminal: true },
    { label: 'Portfolio tracker',       analyst: false,        strategist: true,             terminal: true },
  ]},
];

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill={ACCENT + '18'} />
      <path d="M5 8l2 2 4-4" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Dash() {
  return <span style={{ color: '#D1D5DB', fontSize: 18, lineHeight: 1 }}>—</span>;
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid #E8E9EE', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px 4px' }}>
        <span style={{ fontWeight: 500, fontSize: 14, color: '#111318' }}>{q}</span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round"
          style={{ flexShrink: 0, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {open && <div style={{ padding: '0 4px 15px', fontSize: 13, color: '#6B7280', lineHeight: 1.7 }}>{a}</div>}
    </div>
  );
}

function PricingPage() {
  const [billing, setBilling] = useState('annual');
  const [hoveredPlan, setHoveredPlan] = useState(null);

  const plans = [
    {
      id: 'analyst', tier: 'The Analyst',
      tagline: 'For individual investors building conviction',
      monthly: 14.99, annual: 9.99, highlight: false,
      bullets: ['3 countries', '12-month history', 'Insider Score', '5 alerts/week'],
    },
    {
      id: 'strategist', tier: 'The Strategist',
      tagline: 'For serious traders who demand an edge',
      monthly: 29.99, annual: 19.99, highlight: true,
      bullets: ['10 countries', '5-year history', 'Real-time alerts', 'Portfolio tracker'],
    },
    {
      id: 'terminal', tier: 'The Terminal',
      tagline: 'Institutional depth, zero compromises',
      monthly: 39.99, annual: 24.99, highlight: false,
      bullets: ['All 30+ countries', 'Full archive', 'API access', 'Dedicated manager'],
    },
  ];

  const annualSave = Math.round((1 - 19.99 / 29.99) * 100);

  const proofItems = [
    { label: 'Avg return after A+ buy', value: '+31.4%', sub: '12-month window', color: '#16A34A' },
    { label: 'CEO signal win rate',     value: '74%',    sub: 'last 3 years',    color: ACCENT },
    { label: 'Trades in database',      value: '1.4M+',  sub: 'across 30 countries', color: '#6B7280' },
    { label: 'Filing-to-signal',        value: 'Daily',  sub: 'all plans',       color: '#6B7280' },
  ];

  return (
    <main style={{ flex: 1, overflowY: 'auto', background: '#F7F8FA' }}>
      {/* Hero */}
      <div style={{ background: '#fff', borderBottom: '1px solid #E8E9EE', padding: '72px 40px 60px', textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          borderRadius: 20, padding: '4px 14px', fontSize: 11,
          color: '#15803D', fontFamily: "'DM Mono', monospace",
          letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 28,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#16A34A', display: 'inline-block' }} />
          Institutional-grade insider intelligence
        </div>

        <h1 style={{
          fontSize: 54, fontWeight: 800, letterSpacing: '-0.04em',
          lineHeight: 1.05, color: '#0C0F1A', maxWidth: 700, margin: '0 auto 18px',
        }}>
          Know before the<br />
          <span style={{ color: ACCENT }}>market moves.</span>
        </h1>

        <p style={{ fontSize: 16, color: '#6B7280', maxWidth: 440, margin: '0 auto 40px', lineHeight: 1.65 }}>
          Every insider trade, scored by conviction. The intelligence layer that serious investors run alongside their terminal.
        </p>

        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 0,
          background: '#F3F4F6', border: '1px solid #E2E4E9', borderRadius: 9, padding: 3,
        }}>
          {['monthly', 'annual'].map(b => (
            <button key={b} onClick={() => setBilling(b)} style={{
              padding: '8px 22px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: billing === b ? '#fff' : 'transparent',
              color: billing === b ? '#111318' : '#9CA3AF',
              fontWeight: billing === b ? 600 : 400, fontSize: 13,
              fontFamily: "'DM Sans', sans-serif", transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: 8,
              boxShadow: billing === b ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}>
              {b === 'annual' ? 'Annual' : 'Monthly'}
              {b === 'annual' && (
                <span style={{ fontSize: 10, background: '#DCFCE7', color: '#15803D', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>
                  Save {annualSave}%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '52px 32px' }}>
        {/* Pricing cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, alignItems: 'stretch', marginBottom: 80 }}>
          {plans.map(plan => {
            const price = billing === 'annual' ? plan.annual : plan.monthly;
            const isH = plan.highlight;
            const isHov = hoveredPlan === plan.id;
            return (
              <div
                key={plan.id}
                onMouseEnter={() => setHoveredPlan(plan.id)}
                onMouseLeave={() => setHoveredPlan(null)}
                style={{
                  background: '#fff',
                  border: '1.5px solid ' + (isH ? ACCENT + '55' : isHov ? '#D1D5DB' : '#E8E9EE'),
                  borderRadius: 14, overflow: 'hidden',
                  boxShadow: isH
                    ? '0 0 0 4px ' + ACCENT + '0F, 0 16px 48px rgba(0,0,0,0.09)'
                    : isHov ? '0 6px 20px rgba(0,0,0,0.07)' : '0 1px 4px rgba(0,0,0,0.04)',
                  transition: 'all 0.2s',
                  transform: isH ? 'translateY(-6px)' : isHov ? 'translateY(-2px)' : 'none',
                  position: 'relative',
                }}
              >
                <div style={{ height: 3, background: isH ? ACCENT : 'transparent' }} />
                {isH && (
                  <div style={{
                    position: 'absolute', top: 16, right: 16,
                    background: ACCENT + '14', color: ACCENT,
                    borderRadius: 5, padding: '2px 9px', fontSize: 11, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>Recommended</div>
                )}
                <div style={{ padding: '24px 26px', display: 'flex', flexDirection: 'column', height: 'calc(100% - 3px)' }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                    color: isH ? ACCENT : '#9CA3AF', marginBottom: 5, fontFamily: "'DM Mono', monospace",
                  }}>{plan.tier}</div>
                  <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 24 }}>{plan.tagline}</div>

                  <div style={{ marginBottom: 24, paddingBottom: 22, borderBottom: '1px solid #F3F4F6' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, marginBottom: 4 }}>
                      <span style={{ fontSize: 28, fontWeight: 700, color: '#6B7280', marginBottom: 6, lineHeight: 1, fontFamily: "'DM Mono', monospace" }}>€</span>
                      <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.04em', color: '#0C0F1A', lineHeight: 1, fontFamily: "'DM Mono', monospace" }}>
                        {price.toFixed(2)}
                      </span>
                      <span style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 8 }}>/mo</span>
                    </div>
                    {billing === 'annual' ? (
                      <div style={{ fontSize: 12, color: '#9CA3AF' }}>Billed €{(price * 12).toFixed(2)}/year</div>
                    ) : (
                      <div style={{ fontSize: 12, color: '#9CA3AF' }}>Or €{plan.annual.toFixed(2)}/mo billed annually</div>
                    )}
                  </div>

                  <div style={{ flex: 1 }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 24 }}>
                    {plan.bullets.map((b, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <Check />
                        <span style={{ fontSize: 13, color: '#374151' }}>{b}</span>
                      </div>
                    ))}
                  </div>

                  <button style={{
                    width: '100%', padding: '11px 0', borderRadius: 8,
                    border: isH ? 'none' : '1.5px solid #E2E4E9',
                    background: isH ? ACCENT : '#fff',
                    color: isH ? '#fff' : '#111318',
                    fontWeight: 600, fontSize: 14, cursor: 'pointer',
                    fontFamily: "'DM Sans', sans-serif", transition: 'all 0.15s',
                    boxShadow: isH ? '0 4px 14px ' + ACCENT + '40' : 'none',
                  }}>UNLOCK</button>
                  <div style={{ textAlign: 'center', fontSize: 11, color: '#9CA3AF', marginTop: 8 }}>No card required</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Proof of Performance */}
        <div style={{ marginBottom: 80 }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>
              Proof of Performance
            </div>
            <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.025em', color: '#0C0F1A' }}>The data speaks for itself.</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            {proofItems.map((item, i) => (
              <div key={i} style={{
                background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12,
                padding: '22px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}>
                <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>{item.label}</div>
                <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', color: item.color, fontFamily: "'DM Mono', monospace", marginBottom: 4 }}>{item.value}</div>
                <div style={{ fontSize: 12, color: '#9CA3AF' }}>{item.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Feature grid */}
        <div style={{ marginBottom: 64 }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'DM Mono', monospace", marginBottom: 10 }}>Full Comparison</div>
            <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.025em', color: '#0C0F1A' }}>Everything, side by side.</h2>
          </div>
          <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', borderBottom: '2px solid #F3F4F6' }}>
              <div style={{ padding: '16px 20px' }} />
              {['The Analyst', 'The Strategist', 'The Terminal'].map((name, i) => (
                <div key={i} style={{
                  padding: '16px 20px', textAlign: 'center',
                  borderLeft: '1px solid #F3F4F6',
                  background: i === 1 ? ACCENT + '06' : 'transparent',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: i === 1 ? ACCENT : '#374151', fontFamily: "'DM Mono', monospace" }}>{name}</div>
                  {i === 1 && <div style={{ fontSize: 10, color: ACCENT + 'AA', marginTop: 3 }}>Recommended</div>}
                </div>
              ))}
            </div>
            {PLAN_FEATURES_GRID.map((section, si) => (
              <div key={si}>
                <div style={{ padding: '10px 20px', background: '#F9FAFB', borderTop: si > 0 ? '2px solid #F3F4F6' : 'none', borderBottom: '1px solid #F3F4F6' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'DM Mono', monospace" }}>{section.category}</span>
                </div>
                {section.rows.map((row, ri) => (
                  <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', borderBottom: '1px solid #F9FAFB' }}>
                    <div style={{ padding: '11px 20px', fontSize: 13, color: '#374151' }}>{row.label}</div>
                    {[row.analyst, row.strategist, row.terminal].map((val, ci) => (
                      <div key={ci} style={{
                        padding: '11px 20px', textAlign: 'center',
                        borderLeft: '1px solid #F9FAFB',
                        background: ci === 1 ? ACCENT + '04' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {val === true ? <Check />
                          : val === false ? <Dash />
                          : <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', fontWeight: 500 }}>{val}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* FAQ */}
        <div style={{ maxWidth: 680, margin: '0 auto 32px' }}>
          <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 20, color: '#0C0F1A', textAlign: 'center' }}>Common questions</h3>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {[
              { q: 'How is the Insider Score calculated?', a: 'The score weights trade size relative to estimated salary, change in ownership percentage, executive seniority, and whether the purchase followed a significant price drop. Scores update weekly.' },
              { q: 'How quickly are trades available after filing?', a: 'All trades are processed daily from regulatory filings across 30+ countries.' },
              { q: 'Can I cancel at any time?', a: 'Yes. Cancel any time from your account settings. Annual plans are refunded pro-rata for unused months.' },
            ].map((item, i) => <FAQItem key={i} q={item.q} a={item.a} />)}
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState(() => {
    try { return localStorage.getItem('ia_page') || 'dashboard'; } catch { return 'dashboard'; }
  });
  const [search, setSearch] = useState('');
  const [selectedCountries, setSelectedCountries] = useState(new Set());

  const [trades, setTrades] = useState([]);
  const [buybacks, setBuybacks] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [buybacksLoading, setBuybacksLoading] = useState(true);

  const [performance, setPerformance] = useState([]);
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfLoaded, setPerfLoaded] = useState(false);
  const [selectedInsider, setSelectedInsider] = useState(null);

  const [tradeSort, setTradeSort] = useState({ by: 'transaction_date', dir: 'desc' });
  const [buybackSort, setBuybackSort] = useState({ by: 'announced_date', dir: 'desc' });

  useEffect(() => {
    try { localStorage.setItem('ia_page', page); } catch {}
  }, [page]);

  async function fetchAll(table, orderCol) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table).select('*')
        .order(orderCol, { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  useEffect(() => {
    fetchAll('insider_transactions', 'transaction_date').then(data => {
      setTrades(data);
      setTradesLoading(false);
    });
    fetchAll('buyback_programs', 'announced_date').then(data => {
      setBuybacks(data);
      setBuybacksLoading(false);
    });
  }, []);

  const countryCounts = useMemo(() => {
    const counts = {};
    for (const row of trades) {
      const c = row.country_code;
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [trades]);

  function applyFilters(rows, searchKeys) {
    let result = rows;
    if (selectedCountries.size > 0) result = result.filter(r => selectedCountries.has(r.country_code));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(r => searchKeys.some(k => (r[k] || '').toLowerCase().includes(q)));
    }
    return result;
  }

  const filteredTrades = useMemo(() => {
    const base = applyFilters(trades, ['company', 'ticker', 'insider_name', 'via_entity']);
    return sortRows(base, tradeSort.by, tradeSort.dir, ['shares', 'price_per_share', 'total_value']);
  }, [trades, selectedCountries, search, tradeSort]);

  const filteredBuybacks = useMemo(() => {
    const base = applyFilters(buybacks, ['company', 'ticker']);
    return sortRows(base, buybackSort.by, buybackSort.dir, ['total_value']);
  }, [buybacks, selectedCountries, search, buybackSort]);

  const tradeStats = useMemo(() => {
    const buys = trades.filter(t => ['BUY', 'PURCHASE'].includes((t.transaction_type || '').toUpperCase())).length;
    const sells = trades.filter(t => ['SELL', 'SALE'].includes((t.transaction_type || '').toUpperCase())).length;
    const totalVal = trades.filter(t => t.total_value).reduce((s, t) => s + Number(t.total_value), 0);
    return { total: trades.length, buys, sells, totalVal };
  }, [trades]);

  const buybackStats = useMemo(() => {
    const markets = new Set(buybacks.map(b => b.country_code)).size;
    const latest = buybacks[0]?.announced_date;
    const withVal = buybacks.filter(b => b.total_value);
    const avgSize = withVal.length ? withVal.reduce((s, b) => s + Number(b.total_value), 0) / withVal.length : 0;
    return { total: buybacks.length, markets, latest, avgSize };
  }, [buybacks]);

  useEffect(() => {
    if (page !== 'insiders' || perfLoaded || perfLoading) return;
    setPerfLoading(true);
    fetchAll('insider_performance', 'transaction_date').then(data => {
      setPerformance(data);
      setPerfLoaded(true);
      setPerfLoading(false);
    });
  }, [page]);

  function handleInsiderClick(name) {
    setSelectedInsider(name);
    setPage('insiders');
  }

  function toggleCountry(code) {
    setSelectedCountries(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }
  function clearCountries() { setSelectedCountries(new Set()); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#F7F8FA' }}>
      <TopBar page={page} setPage={setPage} search={search} setSearch={setSearch} />
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {page === 'dashboard' && (
          <DashboardPage
            trades={trades} buybacks={buybacks}
            tradesLoading={tradesLoading} buybacksLoading={buybacksLoading}
            filteredTrades={filteredTrades} filteredBuybacks={filteredBuybacks}
            tradeSort={tradeSort} setTradeSort={setTradeSort}
            buybackSort={buybackSort} setBuybackSort={setBuybackSort}
            tradeStats={tradeStats} buybackStats={buybackStats}
            selectedCountries={selectedCountries}
            toggleCountry={toggleCountry}
            clearCountries={clearCountries}
            countryCounts={countryCounts}
            onInsiderClick={handleInsiderClick}
          />
        )}
        {page === 'watchlist' && (
          <WatchlistPage
            trades={trades}
            tradesLoading={tradesLoading}
            onInsiderClick={handleInsiderClick}
          />
        )}
        {page === 'insiders' && selectedInsider ? (
          <InsiderProfilePage
            insiderName={selectedInsider}
            trades={trades}
            performance={performance}
            onBack={() => setSelectedInsider(null)}
          />
        ) : page === 'insiders' && (
          <InsidersPage
            trades={trades}
            performance={performance}
            tradesLoading={tradesLoading}
            perfLoading={perfLoading}
            onInsiderClick={handleInsiderClick}
          />
        )}
        {page === 'alerts' && (
          <AlertsPage trades={trades} tradesLoading={tradesLoading} />
        )}
        {page === 'pricing' && <PricingPage />}
      </div>
    </div>
  );
}
