import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabase.js';

// Lazy-loaded — lightweight-charts (~175KB) only downloads when first opened
const CompanyPage = lazy(() => import('./CompanyPage.jsx'));

// ─── Constants ────────────────────────────────────────────────────────────────

const COUNTRY_FLAGS = {
  BE: '🇧🇪', CH: '🇨🇭', DE: '🇩🇪', DK: '🇩🇰',
  ES: '🇪🇸', FI: '🇫🇮', FR: '🇫🇷', GB: '🇬🇧',
  IT: '🇮🇹', KR: '🇰🇷', NL: '🇳🇱', NO: '🇳🇴',
  SE: '🇸🇪',
};

const COUNTRY_NAMES = {
  BE: 'Belgium',        CH: 'Switzerland',  DE: 'Germany',
  DK: 'Denmark',        ES: 'Spain',        FI: 'Finland',
  FR: 'France',         GB: 'United Kingdom', IT: 'Italy',
  KR: 'South Korea',    NL: 'Netherlands',  NO: 'Norway',
  SE: 'Sweden',
};

const TRACKED_MARKETS = Object.keys(COUNTRY_FLAGS).sort();

const ACCENT = '#0f1117';

// ─── Watchlist (personal stocks) ─────────────────────────────────────────────

// Hardcoded fallback — used only until the DB watchlist loads
const WATCHLIST_FALLBACK = [
  { ticker: 'VID',  company: 'Vidrala',       country_code: 'ES', yahoo_ticker: 'VID.MC'   },
  { ticker: 'THEP', company: 'Thermador',      country_code: 'FR', yahoo_ticker: 'THEP.PA'  },
  { ticker: 'PRX',  company: 'Prosus',         country_code: 'NL', yahoo_ticker: 'PRX.AS'   },
  { ticker: 'ASML', company: 'ASML',           country_code: 'NL', yahoo_ticker: 'ASML.AS'  },
  { ticker: 'FLOW', company: 'Flow Traders',   country_code: 'NL', yahoo_ticker: 'FLOW.AS'  },
  { ticker: 'JEN',  company: 'Jensen Group',   country_code: 'BE', yahoo_ticker: 'JEN.BR'   },
];

// Match a transaction to a watchlist entry — requires both ticker AND country_code
function matchesWatchlist(watchlist, t) {
  return watchlist.some(w => w.ticker === t.ticker && w.country_code === t.country_code);
}

// ─── Pure filter function (no closure capture) ────────────────────────────────

function applyFilters(rows, searchKeys, selectedCountries, search) {
  const q = search.trim().toLowerCase();
  // When a search query is active it searches GLOBALLY across all countries —
  // the country sidebar filter is ignored so typing "Vidrala" always returns
  // results even if only Sweden is selected.
  if (q) {
    return rows.filter(r => searchKeys.some(k => (r[k] || '').toLowerCase().includes(q)));
  }
  // No search → apply country filter only
  if (selectedCountries.size > 0) {
    return rows.filter(r => selectedCountries.has(r.country_code));
  }
  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', KRW: '₩',
  CHF: 'CHF ', SEK: 'SEK ', DKK: 'DKK ', NOK: 'NOK ',
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
  // Under 1M: show full amount with thousands separator (e.g. SEK 648,750)
  return `${sym}${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatPrice(value, currency = 'EUR') {
  if (value == null || isNaN(value)) return '—';
  const sym = currencySymbol(currency);
  const num = Number(value);
  // Always show at least 2 decimal places; show up to 4 for sub-cent prices
  const decimals = num < 1 ? 4 : 2;
  return `${sym}${num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
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
    // Tiebreaker: group same-company same-day trades together, then by insider name
    const ca = (a.company || '').toLowerCase();
    const cb = (b.company || '').toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ia = (a.insider_name || '').toLowerCase();
    const ib = (b.insider_name || '').toLowerCase();
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

// ─── Design Components ────────────────────────────────────────────────────────

function TypeChip({ type }) {
  const t = (type || '').toUpperCase();
  const isBuy  = t === 'BUY'  || t === 'PURCHASE';
  const isSell = t === 'SELL' || t === 'SALE';
  if (isBuy)  return <span style={{ fontWeight: 600, fontSize: 12, color: '#15803D', background: '#F0FDF4', borderRadius: 4, padding: '2px 8px' }}>BUY</span>;
  if (isSell) return <span style={{ fontWeight: 600, fontSize: 12, color: '#B91C1C', background: '#FEF2F2', borderRadius: 4, padding: '2px 8px' }}>SELL</span>;
  return <span style={{ fontSize: 12, color: '#6B7280', background: '#f0f0f0', borderRadius: 4, padding: '2px 8px' }}>{type || '—'}</span>;
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

// ─── SignalBadges — icon-only signal pills shown right of BUY/SELL ───────────

const IcoTrendingDown = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </svg>
);
const IcoRepeat = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const IcoUsers = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const IcoCalendar = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

// Compact icon badges — order: 📉 🔁 🔄 📅
function SignalBadges({ t, inline = true }) {
  const badges = [];

  if (t.is_price_dip) badges.push({
    key: 'dip',
    icon: <IcoTrendingDown />,
    title: `Bought after ${t.price_drawdown != null ? (Number(t.price_drawdown) * 100).toFixed(0) + '%' : '10%+'} price decline`,
    color: '#EA580C',
    bg: '#FFF7ED',
    border: '#FED7AA',
  });

  if (t.is_repetitive_buy) badges.push({
    key: 'rep',
    icon: <IcoRepeat />,
    title: 'This insider made multiple purchases within 14 days',
    color: '#6B7280',
    bg: '#F9FAFB',
    border: '#E5E7EB',
  });

  if (t.is_cluster_buy) badges.push({
    key: 'cluster',
    icon: <IcoUsers />,
    title: 'Multiple insiders at this company bought within 14 days',
    color: '#4338CA',
    bg: '#EEF2FF',
    border: '#C7D2FE',
  });

  if (t.is_pre_earnings) badges.push({
    key: 'earn',
    icon: <IcoCalendar />,
    title: 'Purchased 30–45 days before a typical earnings blackout period',
    color: '#D97706',
    bg: '#FFFBEB',
    border: '#FDE68A',
  });

  if (badges.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: inline ? 'nowrap' : 'wrap' }}>
      {badges.map(b => (
        <span
          key={b.key}
          title={b.title}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, borderRadius: 4,
            background: b.bg, border: '1px solid ' + b.border,
            color: b.color, flexShrink: 0, cursor: 'default',
          }}
        >{b.icon}</span>
      ))}
    </div>
  );
}

// Profile-page version: icon + label text, used inside "Signals" section
function SignalBadgesFull({ t }) {
  const badges = [];

  if (t.is_price_dip) badges.push({
    key: 'dip',
    icon: <IcoTrendingDown />,
    label: 'Bought on dip',
    title: `Bought after ${t.price_drawdown != null ? (Number(t.price_drawdown) * 100).toFixed(0) + '%' : '10%+'} price decline`,
    color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA',
  });
  if (t.is_repetitive_buy) badges.push({
    key: 'rep',
    icon: <IcoRepeat />,
    label: 'Repetitive buyer',
    title: 'This insider made multiple purchases within 14 days',
    color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB',
  });
  if (t.is_cluster_buy) badges.push({
    key: 'cluster',
    icon: <IcoUsers />,
    label: 'Cluster buy',
    title: 'Multiple insiders at this company bought within 14 days',
    color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE',
  });
  if (t.is_pre_earnings) badges.push({
    key: 'earn',
    icon: <IcoCalendar />,
    label: 'Pre-earnings buy',
    title: 'Purchased 30–45 days before a typical earnings blackout period',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A',
  });

  if (badges.length === 0) return <span style={{ fontSize: 12, color: '#D1D5DB' }}>—</span>;

  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {badges.map(b => (
        <span
          key={b.key}
          title={b.title}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 4,
            background: b.bg, border: '1px solid ' + b.border, color: b.color,
            fontSize: 11, fontWeight: 600, cursor: 'default', whiteSpace: 'nowrap',
          }}
        >
          {b.icon}{b.label}
        </span>
      ))}
    </div>
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
        <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: text, lineHeight: 1 }}>{rating}</div>
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

// ─── ReturnCell — table cell for a post-trade return value ───────────────────

function ReturnCell({ value, daysSince, horizon, style: extraStyle = {} }) {
  const base = { padding: '10px 12px', textAlign: 'right', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', ...extraStyle };
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

// capReturn: if set, individual trade returns are clamped to this value before
// averaging (used in leaderboard to prevent outliers skewing avg_return).
// Profile pages pass no cap so real returns are always shown there.
function computePeriodStats(perfRows, capReturn = null) {
  return PERF_PERIODS.map(p => {
    const mature  = perfRows.filter(r => r[p.rKey] != null);
    const hits    = mature.filter(r => r[p.hKey] === true);
    const returns = mature.map(r => capReturn != null ? Math.min(r[p.rKey], capReturn) : r[p.rKey]);
    return {
      ...p,
      count:       mature.length,
      pending:     perfRows.length - mature.length,
      successRate: mature.length > 0 ? Math.round(hits.length / mature.length * 100) : null,
      avgReturn:   returns.length > 0 ? +(returns.reduce((s, v) => s + v, 0) / returns.length * 100).toFixed(1) : null,
    };
  });
}

// Minimum trade size per currency — filters grants/awards; ~€1,500 equivalent
const LEADERBOARD_THRESH = {
  EUR: 1500, GBP: 1300, USD: 1650, SEK: 17000, DKK: 11000,
  CHF: 1500, NOK: 17000, KRW: 2200000,
};

function meetsLeaderboardThreshold(trade) {
  if (!trade.total_value || Number(trade.total_value) <= 0) return false;
  const thresh = LEADERBOARD_THRESH[trade.currency] ?? LEADERBOARD_THRESH.EUR;
  return Number(trade.total_value) >= thresh;
}

// Corporate entity suffixes / patterns — these are via_entity, not real persons
const CORP_RE = /\b(S\.?A\.?R?\.?L?\.?|S\.?L\.?U?\.?|S\.?A\.?U?\.?|N\.?V\.?|B\.?V\.?|Ltd\.?|LLC|Inc\.?|Corp\.?|plc|GmbH|Soci[eé]t[eé]|Holding|Participations?|Invest(?:ment)?|Capital|Fund|Trust|Compagnie|Groupe|Fondation|Foundation|A\.?S\.?A?\.?|A\.?B\.?|O\.?y\.?)\b/i;

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
    const stats  = computePeriodStats(myPerf, 2.0); // cap at +200% to suppress outlier penny-stock runs
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
      background: '#fff', borderBottom: '1px solid #f0f0f0',
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
            border: '1px solid #f0f0f0', borderRadius: 7, fontSize: 13,
            fontFamily: "'Inter', sans-serif", color: '#111318', background: '#f8f8f8',
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
                background: isActive ? '#f0f0f0' : 'transparent',
                color: isActive ? ACCENT : '#6B7280',
                fontWeight: isActive ? 600 : 400, fontSize: 13,
                cursor: 'pointer', fontFamily: "'Inter', sans-serif",
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
      borderRight: '1px solid #f0f0f0', background: '#fff',
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
              cursor: 'pointer', fontFamily: "'Inter'", padding: 0,
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
                  fontFamily: "'Inter', sans-serif", textAlign: 'left',
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
              </button>
            );
          })}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: '#f0f0f0', margin: '16px 0' }} />

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
        border: '1px solid ' + (hovered ? '#d0d0d0' : '#f0f0f0'),
        borderRadius: 10, padding: 16, cursor: 'default',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.06)' : 'none',
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
            {/* watchlist star rendered by parent if needed */}
          </div>
          <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>
            {row.ticker || '—'} · {COUNTRY_NAMES[row.country_code] || row.country_code}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap' }}>
          <TypeChip type={row.transaction_type} />
          <SignalBadges t={row} />
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
        paddingTop: 8, borderTop: '1px solid #f0f0f0',
      }}>
        <span style={{
          fontWeight: 700, fontSize: 14,
          fontFamily: "'JetBrains Mono', monospace", color: '#111318',
        }}>
          {formatValue(row.total_value, row.currency)}
        </span>
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>{formatDateShort(row.transaction_date)}</span>
      </div>
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function Pagination({ page, totalRows, onChange }) {
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  if (totalPages <= 1 && totalRows <= PAGE_SIZE) return null;

  const from = Math.min((page - 1) * PAGE_SIZE + 1, totalRows);
  const to   = Math.min(page * PAGE_SIZE, totalRows);

  // Build page number list with ellipsis
  function pageNums() {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const near = new Set([1, totalPages, page - 1, page, page + 1].filter(p => p >= 1 && p <= totalPages));
    const sorted = [...near].sort((a, b) => a - b);
    const result = [];
    let prev = 0;
    for (const n of sorted) {
      if (n - prev > 1) result.push('…');
      result.push(n);
      prev = n;
    }
    return result;
  }

  const btnBase = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 28, height: 28, borderRadius: 5, border: '1px solid #f0f0f0',
    background: '#fff', color: '#374151', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
    cursor: 'pointer', fontWeight: 500, padding: '0 6px',
  };
  const activeBtn = { ...btnBase, background: ACCENT, color: '#fff', border: '1px solid ' + ACCENT, fontWeight: 700 };
  const disabledBtn = { ...btnBase, color: '#D1D5DB', cursor: 'default', background: '#fafafa' };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 16px', borderTop: '1px solid #f0f0f0',
    }}>
      <span style={{ fontSize: 12, color: '#9CA3AF' }}>
        Showing <span style={{ color: '#374151', fontWeight: 500 }}>{from.toLocaleString()}–{to.toLocaleString()}</span>
        {' '}of <span style={{ color: '#374151', fontWeight: 500 }}>{totalRows.toLocaleString()}</span> transactions
      </span>
      <div style={{ display: 'flex', gap: 3 }}>
        <button
          style={page === 1 ? disabledBtn : btnBase}
          disabled={page === 1}
          onClick={() => page > 1 && onChange(page - 1)}
        >← Prev</button>

        {pageNums().map((n, i) =>
          n === '…'
            ? <span key={`e${i}`} style={{ display: 'inline-flex', alignItems: 'center', padding: '0 4px', color: '#9CA3AF', fontSize: 12 }}>…</span>
            : <button key={n} style={n === page ? activeBtn : btnBase} onClick={() => onChange(n)}>{n}</button>
        )}

        <button
          style={page === totalPages ? disabledBtn : btnBase}
          disabled={page === totalPages}
          onClick={() => page < totalPages && onChange(page + 1)}
        >Next →</button>
      </div>
    </div>
  );
}

// ─── TradesTable ──────────────────────────────────────────────────────────────

function TradesTable({ rows, loading, sortBy, sortDir, onSort, onInsiderClick, onCompanyClick, page, onPageChange }) {
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
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 95 }} />   {/* Date */}
          <col style={{ width: 145 }} />  {/* Company */}
          <col style={{ width: 145 }} />  {/* Insider */}
          <col style={{ width: 150 }} />  {/* Type + signal icons */}
          <col style={{ width: 100 }} />  {/* Price */}
          <col style={{ width: 105 }} />  {/* Value */}
          <col style={{ width: 60 }} />   {/* Country */}
        </colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
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
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                {cols.map((col, j) => (
                  <td key={j} style={{ padding: rowPad }}>
                    <div style={{
                      height: 14, borderRadius: 4, background: '#f0f0f0',
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
            (page != null ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : rows).map((row, i) => {
              const name = row.insider_name && row.insider_name !== 'Not disclosed'
                ? row.insider_name
                : null;
              const entityFallback = row.via_entity;

              return (
                <tr
                  key={row.id ?? i}
                  style={{ borderBottom: i < rows.length - 1 ? '1px solid #f0f0f0' : 'none', transition: 'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  {/* Date */}
                  <td style={{ padding: rowPad, fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {formatDateShort(row.transaction_date)}
                  </td>
                  {/* Company */}
                  <td style={{ padding: rowPad, overflow: 'hidden' }} title={row.company}>
                    {onCompanyClick ? (
                      <button onClick={() => onCompanyClick(row.ticker, row.company, row.country_code)} style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontWeight: 600, fontSize: 13, color: '#111318', textAlign: 'left',
                        fontFamily: "'Inter', sans-serif", ...truncCell, maxWidth: '100%', display: 'block',
                      }} title={row.company}>{row.company}</button>
                    ) : (
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111318', ...truncCell }}>{row.company}</div>
                    )}
                    {row.ticker && (
                      <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>{row.ticker}</div>
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
                            fontFamily: "'Inter', sans-serif", ...truncCell, maxWidth: '100%', display: 'block',
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
                  {/* Type + signal badges — single line, no wrap */}
                  <td style={{ padding: rowPad }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap' }}>
                      <TypeChip type={row.transaction_type} />
                      <SignalBadges t={row} />
                    </div>
                  </td>
                  {/* Price */}
                  <td style={{ padding: rowPad, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {formatPrice(row.price_per_share, row.currency)}
                  </td>
                  {/* Value */}
                  <td style={{ padding: rowPad, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
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
      {!loading && page != null && onPageChange && (
        <Pagination page={page} totalRows={rows.length} onChange={onPageChange} />
      )}
    </div>
  );
}

// ─── BuybackPrograms — grouped accordion view ─────────────────────────────────

const BUYBACK_STALE_DAYS = 90; // programmes with no execution > 90d ago are hidden by default

function BuybackPrograms({ rows, loading }) {
  const [expanded,     setExpanded]     = useState(new Set());
  const [showInactive, setShowInactive] = useState(false);
  const toggle = key => setExpanded(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  const cutoffDate = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - BUYBACK_STALE_DAYS);
    return d.toISOString().slice(0, 10);
  }, []);

  // Group rows by country_code + normalised company name
  const allPrograms = useMemo(() => {
    const groups = {};
    for (const row of rows) {
      const key = `${row.country_code}|${(row.company || '').toLowerCase().trim().slice(0, 40)}`;
      if (!groups[key]) groups[key] = { key, company: row.company, ticker: row.ticker || '', country_code: row.country_code, currency: row.currency, executions: [] };
      groups[key].executions.push(row);
    }
    return Object.values(groups).map(g => {
      const sorted = [...g.executions].sort((a, b) => (b.execution_date||'').localeCompare(a.execution_date||''));
      const latest = sorted[0];

      // Use the row with completion_pct as the "enriched" row for programme data.
      // total_value is reliable as programme max only when completion_pct is set —
      // otherwise it might be a legacy weekly execution value.
      const enriched = sorted.find(r => r.completion_pct != null) || null;

      const programMax = enriched ? (Number(enriched.total_value) || null) : null;
      const spentCumul = enriched
        ? (Number(enriched.spent_value || enriched.cumulative_value) || null)
        : null;
      const cumShares = enriched ? (Number(enriched.cumulative_shares) || null) : null;

      // For shares display: prefer cumulative_shares from enriched row, else sum weekly
      const execRows  = g.executions.filter(r => r.shares_bought != null);
      const sumShares = execRows.reduce((s, r) => s + Number(r.shares_bought || 0), 0);
      const totalShares = cumShares || (sumShares > 0 ? sumShares : null);

      // Avg price from latest execution that has one
      const avgPrice = Number(latest?.avg_price) || null;

      // Programme start = earliest announced_date (set to program_start by scraper)
      // Programme latest = most recent execution_date
      const announcedDates = g.executions.map(r => r.announced_date).filter(Boolean).sort();
      const execDates      = g.executions.map(r => r.execution_date).filter(Boolean).sort();
      const firstDate = announcedDates[0] || execDates[0];
      const lastDate  = execDates[execDates.length - 1] || announcedDates[announcedDates.length - 1];

      // completion_pct: use enriched value; derive from spent/max if both available
      const rawPct = enriched?.completion_pct ?? (
        programMax && spentCumul && programMax > 0
          ? Math.round((spentCumul / programMax) * 1000) / 10
          : null
      );
      // Discard bogus completion values (>150% = programme max was extracted wrong)
      const completionPct = rawPct != null && rawPct <= 150 ? rawPct : null;

      const isStale = lastDate < cutoffDate;
      const status  = completionPct >= 95  ? 'Completed'
                    : latest?.status === 'Announced' ? 'Announced'
                    : isStale ? 'Expired'
                    : 'Active';

      return {
        ...g,
        programMax, spentCumul, cumShares: totalShares, avgPrice,
        firstDate, lastDate, executionCount: execRows.length,
        completionPct, status, isStale,
        executions: sorted,
      };
    }).sort((a, b) => (b.lastDate||'').localeCompare(a.lastDate||''));
  }, [rows, cutoffDate]);

  const programs = useMemo(() =>
    showInactive ? allPrograms : allPrograms.filter(p => !p.isStale && p.status !== 'Completed'),
    [allPrograms, showInactive]
  );

  const hiddenCount = allPrograms.length - programs.length;

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, padding: '18px 20px' }}>
            <div style={{ height: 14, width: 200, background: '#f0f0f0', borderRadius: 4, marginBottom: 10 }} />
            <div style={{ height: 6, width: '60%', background: '#f0f0f0', borderRadius: 3, marginBottom: 8 }} />
            <div style={{ height: 12, width: 280, background: '#f0f0f0', borderRadius: 4 }} />
          </div>
        ))}
      </div>
    );
  }
  if (programs.length === 0 && !loading) {
    return (
      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, padding: '60px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: '#9CA3AF' }}>No active buyback programs</div>
        {hiddenCount > 0 && (
          <button onClick={() => setShowInactive(true)} style={{
            marginTop: 10, fontSize: 12, color: ACCENT, background: 'none', border: 'none',
            cursor: 'pointer', fontFamily: "'Inter', sans-serif",
          }}>Show {hiddenCount} completed / expired programs</button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Toggle for completed/expired programs */}
      {hiddenCount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => setShowInactive(v => !v)} style={{
            fontSize: 12, color: ACCENT, background: 'none', border: '1px solid #f0f0f0',
            borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontFamily: "'Inter', sans-serif",
          }}>
            {showInactive ? `Hide completed/expired` : `Show ${hiddenCount} completed/expired`}
          </button>
        </div>
      )}

      {programs.map(p => {
        const isExpanded = expanded.has(p.key);
        const pct = p.completionPct != null ? Number(p.completionPct) : null;
        const statusCfg =
          p.status === 'Completed' ? { bg: '#F0FDF4', color: '#16A34A', border: '#BBF7D0' } :
          p.status === 'Expired'   ? { bg: '#F9FAFB', color: '#9CA3AF', border: '#E5E7EB' } :
          p.status === 'Announced' ? { bg: '#EEF2FF', color: ACCENT,    border: '#C7D2FE' } :
                                     { bg: '#FFFBEB', color: '#D97706', border: '#FDE68A' };

        return (
          <div key={p.key} style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
            {/* ── Program card header ─────────────────────────────────── */}
            <div
              onClick={() => toggle(p.key)}
              style={{ padding: '16px 20px', cursor: 'pointer', userSelect: 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              {/* Row 1: flag + company + status */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <Flag code={p.country_code} />
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#111318', marginRight: 8 }}>
                      {p.company || '—'}
                    </span>
                    {p.ticker && <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#9CA3AF' }}>({p.ticker})</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                    background: statusCfg.bg, color: statusCfg.color, border: '1px solid ' + statusCfg.border,
                  }}>{p.status}</span>
                  <span style={{ fontSize: 12, color: '#9CA3AF' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Row 2: progress bar — only when completion_pct is known */}
              {pct != null && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: '#6B7280' }}>
                      {p.spentCumul && p.programMax
                        ? <>{formatValue(p.spentCumul, p.currency)} <span style={{ color: '#9CA3AF' }}>of {formatValue(p.programMax, p.currency)}</span></>
                        : p.programMax
                          ? <span style={{ color: '#9CA3AF' }}>Max {formatValue(p.programMax, p.currency)}</span>
                          : null}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: pct >= 95 ? '#16A34A' : ACCENT, fontFamily: "'JetBrains Mono', monospace" }}>
                      {pct.toFixed(1)}% complete
                    </span>
                  </div>
                  <div style={{ height: 6, background: '#f0f0f0', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, pct)}%`,
                      background: pct >= 95 ? '#16A34A' : ACCENT, borderRadius: 4, transition: 'width 0.4s' }} />
                  </div>
                </div>
              )}

              {/* Row 3: stats */}
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {p.cumShares > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 1 }}>Total Shares</div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: '#111318' }}>
                      {p.cumShares.toLocaleString('en-US')}
                    </div>
                  </div>
                )}
                {p.avgPrice != null && (
                  <div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 1 }}>Latest Avg Price</div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: '#111318' }}>
                      {formatPrice(p.avgPrice, p.currency)}
                    </div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 1 }}>Period</div>
                  <div style={{ fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace" }}>
                    {p.firstDate
                      ? `${formatDateShort(p.firstDate)} → ${p.lastDate ? formatDateShort(p.lastDate) : 'Ongoing'}`
                      : '—'}
                  </div>
                </div>
                {p.executionCount > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 1 }}>Reports</div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: '#111318' }}>{p.executionCount}</div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Expanded execution rows ─────────────────────────────── */}
            {isExpanded && (
              <div style={{ borderTop: '1px solid #f0f0f0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
                      {['Date', 'Shares', 'Avg Price', 'Daily Value', 'Progress'].map((h, i) => (
                        <th key={h} style={{
                          padding: '7px 16px', fontSize: 10, fontWeight: 600, color: '#9CA3AF',
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          textAlign: i >= 1 && i <= 3 ? 'right' : 'left',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.executions.map((ex, i) => (
                      <tr key={ex.id ?? i}
                        style={{ borderBottom: i < p.executions.length - 1 ? '1px solid #f0f0f0' : 'none' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <td style={{ padding: '7px 16px', fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                          {formatDateShort(ex.execution_date || ex.announced_date)}
                        </td>
                        <td style={{ padding: '7px 16px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {ex.shares_bought != null ? Number(ex.shares_bought).toLocaleString('en-US') : '—'}
                        </td>
                        <td style={{ padding: '7px 16px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {ex.avg_price != null ? formatPrice(ex.avg_price, ex.currency) : '—'}
                        </td>
                        <td style={{ padding: '7px 16px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {formatValue(ex.total_value, ex.currency)}
                        </td>
                        <td style={{ padding: '7px 16px' }}>
                          {ex.completion_pct != null ? (
                            <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: ACCENT, fontWeight: 600 }}>
                              {Number(ex.completion_pct).toFixed(1)}%
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: '#D1D5DB' }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.executions[0]?.filing_url && (
                  <div style={{ padding: '8px 16px', borderTop: '1px solid #f0f0f0' }}>
                    <a href={p.executions[0].filing_url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11, color: ACCENT, textDecoration: 'none' }}>
                      View latest filing ↗
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── BuybackTable ─────────────────────────────────────────────────────────────

function BuybackTable({ rows, loading, sortBy, sortDir, onSort }) {
  const cols = [
    { key: 'execution_date', label: 'Date',       align: 'left',  sortable: true  },
    { key: 'company',        label: 'Company',     align: 'left',  sortable: true  },
    { key: 'country_code',   label: 'Country',     align: 'left',  sortable: false },
    { key: 'shares_bought',  label: 'Shares',      align: 'right', sortable: true  },
    { key: 'avg_price',      label: 'Avg Price',   align: 'right', sortable: true  },
    { key: 'total_value',    label: 'Value',       align: 'right', sortable: true  },
    { key: 'completion_pct', label: 'Progress',    align: 'left',  sortable: true  },
    { key: 'status',         label: 'Status',      align: 'left',  sortable: false },
  ];

  const rowPad = '8px 14px';

  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
              {cols.map(col => (
                <th key={col.key} onClick={() => col.sortable && onSort(col.key)} style={{
                  padding: '10px 14px', textAlign: col.align,
                  fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: col.sortable ? 'pointer' : 'default',
                  userSelect: 'none', whiteSpace: 'nowrap',
                }}>
                  {col.label}
                  {col.sortable && (sortBy === col.key
                    ? <span style={{ color: ACCENT }}>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>
                    : <span style={{ color: '#D1D5DB' }}> ↕</span>)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  {cols.map((_, j) => (
                    <td key={j} style={{ padding: rowPad }}>
                      <div style={{ height: 13, borderRadius: 4, background: '#f0f0f0', width: j === 1 ? 120 : 60 }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length} style={{ padding: '60px 20px', textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: '#9CA3AF' }}>No buyback programs found</div>
                  <div style={{ fontSize: 12, color: '#D1D5DB', marginTop: 4 }}>Norway and UK buybacks scraped daily</div>
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const pct    = row.completion_pct != null ? Number(row.completion_pct) : null;
                const isAnn  = row.status === 'Announced';
                return (
                  <tr key={row.id ?? i}
                    style={{ borderBottom: i < rows.length - 1 ? '1px solid #f0f0f0' : 'none' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    {/* Date */}
                    <td style={{ padding: rowPad, fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                      {formatDateShort(row.execution_date || row.announced_date)}
                    </td>
                    {/* Company */}
                    <td style={{ padding: rowPad, maxWidth: 200, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111318', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={row.company}>{row.company || '—'}</div>
                      {row.ticker && <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>{row.ticker}</div>}
                    </td>
                    {/* Country */}
                    <td style={{ padding: rowPad }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Flag code={row.country_code} />
                        <span style={{ fontSize: 12, color: '#6B7280' }}>{row.country_code}</span>
                      </div>
                    </td>
                    {/* Shares bought */}
                    <td style={{ padding: rowPad, textAlign: 'right', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', whiteSpace: 'nowrap' }}>
                      {row.shares_bought != null ? Number(row.shares_bought).toLocaleString('en-US') : '—'}
                    </td>
                    {/* Avg price */}
                    <td style={{ padding: rowPad, textAlign: 'right', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', whiteSpace: 'nowrap' }}>
                      {row.avg_price != null ? formatPrice(row.avg_price, row.currency) : '—'}
                    </td>
                    {/* Total value */}
                    <td style={{ padding: rowPad, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: '#111318' }}>
                        {formatValue(row.total_value, row.currency)}
                      </span>
                    </td>
                    {/* Progress bar */}
                    <td style={{ padding: rowPad, minWidth: 110 }}>
                      {pct != null ? (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                            <span style={{ fontSize: 11, color: '#374151', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{pct.toFixed(1)}%</span>
                          </div>
                          <div style={{ height: 5, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: ACCENT, borderRadius: 3 }} />
                          </div>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: '#D1D5DB' }}>—</span>
                      )}
                    </td>
                    {/* Status */}
                    <td style={{ padding: rowPad }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                        background: isAnn ? '#EEF2FF' : '#F0FDF4',
                        color:      isAnn ? ACCENT    : '#16A34A',
                      }}>
                        {row.status || 'Active'}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── WatchlistPage ────────────────────────────────────────────────────────────

function WatchlistPage({ trades, tradesLoading, buybacks, watchlist, watchlistTickers, addToWatchlist, onInsiderClick, onCompanyClick }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [newStock, setNewStock] = useState({ ticker: '', company: '', country_code: 'SE', yahoo_ticker: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  async function handleAddStock(e) {
    e.preventDefault();
    if (!newStock.ticker.trim() || !newStock.company.trim()) return;
    setSaving(true);
    setSaveError('');
    const success = await addToWatchlist({
      ticker: newStock.ticker.trim().toUpperCase(),
      company: newStock.company.trim(),
      country_code: newStock.country_code,
      yahoo_ticker: newStock.yahoo_ticker.trim() || null,
    });
    setSaving(false);
    if (success) {
      setShowAddModal(false);
      setNewStock({ ticker: '', company: '', country_code: 'SE', yahoo_ticker: '' });
    } else {
      setSaveError('Failed to save — ticker may already exist.');
    }
  }

  const watchlistTrades = useMemo(() => {
    const result = {};
    for (const w of watchlist) result[w.ticker] = { ...w, buys: [], sells: [] };

    for (const t of trades) {
      if (!matchesWatchlist(watchlist, t)) continue;
      const entry = result[t.ticker];
      if (!entry) continue;
      const type = (t.transaction_type || '').toUpperCase();
      if (type === 'BUY' || type === 'PURCHASE') entry.buys.push(t);
      else entry.sells.push(t);
    }
    return Object.values(result);
  }, [trades, watchlist]);

  const allWatchlistTrades = useMemo(() => {
    return trades
      .filter(t => matchesWatchlist(watchlist, t))
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
  }, [trades, watchlist]);

  // Buyback signals: any buyback_programs row whose ticker matches a watchlist stock
  const watchlistBuybacks = useMemo(() => {
    if (!buybacks?.length) return [];
    return buybacks
      .filter(b => watchlist.some(w => w.ticker === b.ticker && w.country_code === b.country_code))
      .sort((a, b) => (b.announced_date || '').localeCompare(a.announced_date || ''))
      .slice(0, 10);
  }, [buybacks, watchlist]);

  return (
    <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0 }}>
      {/* Add stock modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowAddModal(false)}>
          <div style={{
            background: '#fff', borderRadius: 14, padding: '28px 32px',
            width: 420, boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
            position: 'relative',
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', marginBottom: 20 }}>Add stock to watchlist</h2>
            <form onSubmit={handleAddStock}>
              {[
                { label: 'Company name', key: 'company', placeholder: 'AB Industrivärden' },
                { label: 'Ticker', key: 'ticker', placeholder: 'INDU-C' },
                { label: 'Yahoo Finance ticker', key: 'yahoo_ticker', placeholder: 'INDU-C.ST' },
              ].map(f => (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>{f.label}</label>
                  <input
                    value={newStock[f.key]}
                    onChange={e => setNewStock(s => ({ ...s, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    style={{
                      width: '100%', padding: '8px 12px', border: '1px solid #D1D5DB',
                      borderRadius: 7, fontSize: 13, fontFamily: "'Inter', sans-serif",
                      outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </div>
              ))}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Country</label>
                <select
                  value={newStock.country_code}
                  onChange={e => setNewStock(s => ({ ...s, country_code: e.target.value }))}
                  style={{
                    width: '100%', padding: '8px 12px', border: '1px solid #D1D5DB',
                    borderRadius: 7, fontSize: 13, fontFamily: "'Inter', sans-serif",
                    background: '#fff', outline: 'none', boxSizing: 'border-box',
                  }}
                >
                  {TRACKED_MARKETS.map(code => (
                    <option key={code} value={code}>{COUNTRY_FLAGS[code]} {COUNTRY_NAMES[code]} ({code})</option>
                  ))}
                </select>
              </div>
              {saveError && <p style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{saveError}</p>}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowAddModal(false)} style={{
                  padding: '8px 18px', border: '1px solid #D1D5DB', borderRadius: 7,
                  background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: "'Inter', sans-serif",
                }}>Cancel</button>
                <button type="submit" disabled={saving} style={{
                  padding: '8px 18px', border: 'none', borderRadius: 7,
                  background: ACCENT, color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 13, fontWeight: 600, fontFamily: "'Inter', sans-serif",
                  opacity: saving ? 0.7 : 1,
                }}>{saving ? 'Saving…' : 'Add to watchlist'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 28, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: '#111318', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: ACCENT }}>★</span> My Watchlist
          </h1>
          <p style={{ fontSize: 13, color: '#9CA3AF' }}>Insider activity in your personally tracked stocks</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          title="Add stock to watchlist"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', background: ACCENT, color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer',
            fontSize: 13, fontWeight: 600, fontFamily: "'Inter', sans-serif",
            marginTop: 2, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Add stock
        </button>
      </div>

      {/* Stock summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 32 }}>
        {watchlistTrades.map(w => {
          const latestBuy = w.buys[0];
          const hasCluster = w.buys.some(b => b.is_cluster_buy);
          const recentBuys90 = w.buys.filter(b => (Date.now() - new Date(b.transaction_date)) / 86400000 <= 90);

          return (
            <div key={w.ticker} style={{
              background: '#fff',
              border: '1px solid ' + (hasCluster ? '#C7D2FE' : '#f0f0f0'),
              borderTop: '3px solid ' + (hasCluster ? '#4338CA' : '#e0e0e0'),
              borderRadius: 10, padding: 16,
              boxShadow: hasCluster ? '0 4px 16px rgba(0,0,0,0.06)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <button onClick={() => onCompanyClick && onCompanyClick(w.ticker, w.company, w.country_code)} style={{
                    background: 'none', border: 'none', padding: 0, cursor: onCompanyClick ? 'pointer' : 'default',
                    fontWeight: 700, fontSize: 14, color: onCompanyClick ? ACCENT : '#111318',
                    textAlign: 'left', fontFamily: "'Inter', sans-serif",
                  }}>{w.company}</button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#9CA3AF' }}>{w.ticker}</span>
                    <Flag code={w.country_code} />
                  </div>
                </div>
                {hasCluster && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, background: '#EEF2FF', color: '#4338CA', border: '1px solid #C7D2FE', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>
                    <IcoUsers /> Cluster
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Buys (90d)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: recentBuys90.length > 0 ? '#15803D' : '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>
                    {recentBuys90.length}
                  </div>
                </div>
                {latestBuy && (
                  <div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Last Buy</div>
                    <div style={{ fontSize: 12, color: '#374151', fontFamily: "'JetBrains Mono', monospace" }}>{formatValue(latestBuy.total_value, latestBuy.currency)}</div>
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
                    <SignalBadges t={latestBuy} />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#D1D5DB', textAlign: 'center', padding: '8px 0' }}>No recent insider buys</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Buyback signals for watchlist stocks */}
      {watchlistBuybacks.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🔄</span> Buyback Programs
            </h2>
            <p style={{ fontSize: 13, color: '#9CA3AF', marginTop: 2 }}>Active share repurchase programs for your watchlist stocks</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {watchlistBuybacks.map((b, i) => {
              const pct = b.completion_pct != null ? Number(b.completion_pct) : null;
              return (
                <div key={b.id ?? i} style={{
                  background: '#fff', border: '1px solid #f0f0f0', borderLeft: '3px solid ' + ACCENT,
                  borderRadius: 8, padding: '12px 16px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Flag code={b.country_code} />
                      <span style={{ fontWeight: 600, fontSize: 13, color: '#111318' }}>{b.company}</span>
                      {b.ticker && <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#9CA3AF' }}>{b.ticker}</span>}
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
                        background: b.status === 'Announced' ? '#EEF2FF' : '#FFFBEB',
                        color: b.status === 'Announced' ? ACCENT : '#D97706',
                      }}>{b.status || 'Active'}</span>
                    </div>
                    {pct != null && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 4, background: '#f0f0f0', borderRadius: 2, overflow: 'hidden', maxWidth: 150 }}>
                          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: ACCENT, borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: ACCENT, fontWeight: 600 }}>{pct.toFixed(1)}%</span>
                        {b.spent_value && b.total_value && (
                          <span style={{ fontSize: 11, color: '#9CA3AF' }}>
                            {formatValue(b.spent_value, b.currency)} of {formatValue(b.total_value, b.currency)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 12, color: '#374151', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                      {b.cumulative_shares ? Number(b.cumulative_shares).toLocaleString('en-US') + ' shares' : formatValue(b.total_value, b.currency)}
                    </div>
                    <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{formatDateShort(b.announced_date)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* All watchlist transactions table */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em' }}>Recent Transactions</h2>
            <p style={{ fontSize: 13, color: '#9CA3AF', marginTop: 2 }}>All insider trades in your watchlist stocks</p>
          </div>
          {!tradesLoading && (
            <span style={{ fontSize: 12, color: '#9CA3AF', background: '#f8f8f8', border: '1px solid #f0f0f0', borderRadius: 6, padding: '4px 10px' }}>
              {allWatchlistTrades.length} transactions
            </span>
          )}
        </div>

        {tradesLoading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#9CA3AF', fontSize: 13 }}>Loading…</div>
        ) : allWatchlistTrades.length === 0 ? (
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, padding: '48px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#9CA3AF' }}>No insider transactions found for watchlist stocks</div>
            <div style={{ fontSize: 12, color: '#D1D5DB', marginTop: 4 }}>Transactions will appear here as they are filed</div>
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
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
                <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
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
                      style={{ borderBottom: i < allWatchlistTrades.length - 1 ? '1px solid #f0f0f0' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      <td style={{ padding: '10px 16px', fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                        {formatDateShort(t.transaction_date)}
                      </td>
                      <td style={{ padding: '10px 16px', overflow: 'hidden' }}>
                        {onCompanyClick ? (
                          <button onClick={() => onCompanyClick(t.ticker, t.company, t.country_code)} style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                            fontWeight: 600, fontSize: 13, color: '#111318', fontFamily: "'Inter', sans-serif",
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', display: 'block',
                          }}>{t.company}</button>
                        ) : (
                          <div style={{ fontWeight: 600, fontSize: 13, color: '#111318', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.company}</div>
                        )}
                        <div style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>{t.ticker}</div>
                      </td>
                      <td style={{ padding: '10px 16px', overflow: 'hidden' }}>
                        {name ? (
                          onInsiderClick ? (
                            <button onClick={() => onInsiderClick(name)} style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontWeight: 500, fontSize: 13, color: ACCENT, textAlign: 'left',
                              fontFamily: "'Inter', sans-serif", overflow: 'hidden', textOverflow: 'ellipsis',
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
                      <td style={{ padding: '10px 16px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {formatPrice(t.price_per_share, t.currency)}
                      </td>
                      <td style={{ padding: '10px 16px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
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
  countryCounts, onInsiderClick, onCompanyClick,
}) {
  const [activeTab, setActiveTab] = useState('trades');
  const [tradePage, setTradePage] = useState(1);
  const [avgReturn30d, setAvgReturn30d] = useState(null);

  // Reset to page 1 whenever the filtered set changes (search, country, sort)
  useEffect(() => { setTradePage(1); }, [filteredTrades]);

  // Fetch avg 30d return from insider_performance (profitable trades only)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      let sum = 0, count = 0, from = 0;
      while (true) {
        const { data } = await supabase
          .from('insider_performance')
          .select('return_30d')
          .not('return_30d', 'is', null)
          .eq('hit_rate_30d', true)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        for (const r of data) { sum += Math.min(Number(r.return_30d), 2.0); count++; }
        if (data.length < 1000) break;
        from += 1000;
      }
      if (!cancelled) setAvgReturn30d(count > 0 ? sum / count : null);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function handleTradeSort(col) {
    setTradePage(1);
    setTradeSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'desc' }));
  }
  function handleBuybackSort(col) {
    setBuybackSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'desc' }));
  }

  // Signal KPIs — last 14 days only
  const cutoff14d = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10);
  }, []);
  const last14 = useMemo(
    () => trades.filter(t => t.transaction_date >= cutoff14d),
    [trades, cutoff14d],
  );
  const highConvictionBuys = useMemo(
    () => last14.filter(t => (t.transaction_type === 'BUY' || t.transaction_type === 'PURCHASE') && t.conviction_label === 'High Conviction').length,
    [last14],
  );
  const clusterSignals = useMemo(
    () => new Set(last14.filter(t => t.is_cluster_buy).map(t => t.company)).size,
    [last14],
  );
  const repeatBuyers = useMemo(
    () => new Set(last14.filter(t => t.is_repetitive_buy && t.insider_name).map(t => t.insider_name)).size,
    [last14],
  );

  const kpis = [
    {
      icon: '🔥',
      label: 'High Conviction Buys',
      value: tradesLoading ? '…' : highConvictionBuys.toLocaleString(),
      sub: 'Last 14 days',
    },
    {
      icon: '🔄',
      label: 'Cluster Signals',
      value: tradesLoading ? '…' : clusterSignals.toLocaleString(),
      sub: 'Companies with cluster buying',
    },
    {
      icon: '🔁',
      label: 'Repeat Buyers',
      value: tradesLoading ? '…' : repeatBuyers.toLocaleString(),
      sub: 'Active repeat buyers',
    },
    {
      icon: '📈',
      label: 'Avg Insider Return',
      value: avgReturn30d === null ? '…' : '+' + (avgReturn30d * 100).toFixed(1) + '%',
      sub: '30d avg (profitable trades)',
      color: '#15803D',
    },
  ];

  const isLoading = activeTab === 'trades' ? tradesLoading : buybacksLoading;
  const activeCount = activeTab === 'trades' ? filteredTrades.length : filteredBuybacks.length;
  const totalCount  = activeTab === 'trades' ? trades.length : buybacks.length;
  // Distinct program count for buybacks tab (groups by company+country)
  const buybackProgramCount = useMemo(() => {
    const keys = new Set(filteredBuybacks.map(r => `${r.country_code}|${(r.company||'').toLowerCase().trim().slice(0,40)}`));
    return keys.size;
  }, [filteredBuybacks]);

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <Sidebar
        selectedCountries={selectedCountries}
        toggleCountry={toggleCountry}
        clearCountries={clearCountries}
        countryCounts={countryCounts}
      />
      <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0 }}>

        {/* Signal KPI row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 32 }}>
          {kpis.map((k, i) => (
            <div key={i} style={{
              background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10,
              padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 13, lineHeight: 1 }}>{k.icon}</span>
                <span style={{
                  fontSize: 10, color: '#9CA3AF', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.07em',
                }}>{k.label}</span>
              </div>
              <span style={{
                fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em',
                color: k.color || '#111318',
                fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.1,
              }}>{k.value}</span>
              <div style={{ fontSize: 11, color: '#9CA3AF' }}>{k.sub}</div>
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
                background: '#f8f8f8', border: '1px solid #f0f0f0',
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
                      fontSize: 12, fontFamily: "'Inter', sans-serif",
                      boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                      transition: 'all 0.15s',
                    }}
                  >{tab.label}</button>
                ))}
              </div>
              {!isLoading && (
                <span style={{
                  fontSize: 12, color: '#9CA3AF', background: '#f8f8f8',
                  border: '1px solid #f0f0f0', borderRadius: 6, padding: '4px 10px',
                }}>
                  {activeTab === 'buybacks'
                    ? `${buybackProgramCount} programs`
                    : `${activeCount.toLocaleString()} / ${totalCount.toLocaleString()}`}
                </span>
              )}
            </div>
          </div>

          {activeTab === 'trades' ? (
            <TradesTable
              key={[...selectedCountries].sort().join(',')}
              rows={filteredTrades}
              loading={tradesLoading}
              sortBy={tradeSort.by}
              sortDir={tradeSort.dir}
              onSort={handleTradeSort}
              onInsiderClick={onInsiderClick}
              onCompanyClick={onCompanyClick}
              page={tradePage}
              onPageChange={setTradePage}
            />
          ) : (
            <BuybackPrograms rows={filteredBuybacks} loading={buybacksLoading} />
          )}

          {/* Buybacks footer — pagination handles trades inline in the table */}
          {!isLoading && activeTab === 'buybacks' && activeCount > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 16px',
              background: '#fff', border: '1px solid #f0f0f0', borderRadius: '0 0 10px 10px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderTop: 'none',
            }}>
              <p style={{ fontSize: 12, color: '#9CA3AF' }}>
                <span style={{ color: '#374151', fontWeight: 500 }}>{activeCount.toLocaleString()}</span>
                {' '}programs · sourced from regulatory filings
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── InsiderProfilePage ───────────────────────────────────────────────────────

function InsiderProfilePage({ insiderName, trades, performance, onBack, onCompanyClick, backLabel }) {
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
        <div style={{ fontSize: 22, fontWeight: 800, color: '#D1D5DB', fontFamily: "'JetBrains Mono', monospace" }}>—</div>
        <div style={{ fontSize: 10, color: '#D1D5DB', marginTop: 2 }}>pending</div>
      </div>
    );
    const pct = (value * 100).toFixed(1);
    const pos = value > 0;
    return (
      <div>
        <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1, color: pos ? '#15803D' : '#B91C1C' }}>
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
          fontFamily: "'Inter', sans-serif",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {backLabel || 'Back to leaderboard'}
        </button>

        {/* Profile header */}
        <div style={{
          background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
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
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'JetBrains Mono', monospace" }}>{myBuys.length}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Total Invested</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#16A34A', fontFamily: "'JetBrains Mono', monospace" }}>{formatValue(totalInvested, currency)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Avg Buy Price</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'JetBrains Mono', monospace" }}>
                  {avgBuyPrice != null ? formatPrice(avgBuyPrice, currency) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Tracked</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111318', fontFamily: "'JetBrains Mono', monospace" }}>{myPerf.length}</div>
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
            <div key={card.label} style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>{card.label}</div>
              <ReturnKpi value={card.value} label="" />
            </div>
          ))}
        </div>

        {/* Period win-rate cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
          {stats.map(s => (
            <div key={s.key} style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
                {s.label} win rate
              </div>
              {s.count > 0 ? (
                <>
                  <div style={{
                    fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em',
                    fontFamily: "'JetBrains Mono', monospace", lineHeight: 1, marginBottom: 4,
                    color: s.successRate >= 60 ? '#16A34A' : s.successRate >= 40 ? '#D97706' : '#DC2626',
                  }}>{s.successRate}%</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>{s.count} trades resolved</div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: s.avgReturn > 0 ? '#16A34A' : '#DC2626' }}>
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
        <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Transaction History</span>
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>{myTrades.length} transactions</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                {[
                  { label: 'Date',       align: 'left'  },
                  { label: 'Shares',     align: 'right' },
                  { label: 'Buy Price',  align: 'right' },
                  { label: 'Value',      align: 'right' },
                  { label: '30d',        align: 'right' },
                  { label: '90d',        align: 'right' },
                  { label: '6m',         align: 'right' },
                  { label: '1y',         align: 'right' },
                  { label: 'Signals',    align: 'left'  },
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
                    style={{ borderBottom: i < myTrades.length - 1 ? '1px solid #f0f0f0' : 'none' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace" }}>{formatDateShort(t.transaction_date)}</div>
                      {t.company && (
                        onCompanyClick ? (
                          <button onClick={() => onCompanyClick(t.ticker, t.company, t.country_code)} style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                            fontSize: 10, color: ACCENT, fontFamily: "'Inter', sans-serif",
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120, display: 'block',
                          }} title={t.company}>{t.ticker || t.company}</button>
                        ) : (
                          <div style={{ fontSize: 10, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }} title={t.company}>{t.ticker || t.company}</div>
                        )
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right' }}>
                      {t.shares != null ? formatShares(t.shares) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {t.price_per_share != null ? formatPrice(t.price_per_share, t.currency) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                      {isBuy
                        ? <SignalBadgesFull t={t} />
                        : <TypeChip type={t.transaction_type} />
                      }
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

function InsidersPage({ trades, performance, tradesLoading, perfLoading, onInsiderClick, onCompanyClick }) {
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
        <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}%</div>
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
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Leaderboard</span>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>Top {leaderboard.length} insiders · ranked by performance score</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
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
                        style={{ borderBottom: i < leaderboard.length - 1 ? '1px solid #f0f0f0' : 'none', transition: 'background 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
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
                                fontFamily: "'Inter', sans-serif", display: 'block',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
                              }}>{ins.name}</button>
                              {ins.role && (
                                <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{ins.role}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          {onCompanyClick ? (() => {
                            const t = trades.find(tr => tr.insider_name === ins.name && tr.company === ins.company);
                            return (
                              <button onClick={() => onCompanyClick(t?.ticker || null, ins.company, ins.country_code)} style={{
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontSize: 12, color: ACCENT, textAlign: 'left', fontFamily: "'Inter', sans-serif",
                                display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
                              }}>{ins.company}</button>
                            );
                          })() : (
                            <div style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{ins.company}</div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Flag code={ins.country_code} />
                            <span style={{ fontSize: 11, color: '#9CA3AF' }}>{ins.country_code}</span>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#111318', fontFamily: "'JetBrains Mono', monospace" }}>{ins.buys}</td>
                        {/* Avg Win Rate */}
                        <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                          {winRate != null ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 700, color: winRate >= 60 ? '#16A34A' : winRate >= 40 ? '#D97706' : '#DC2626', fontFamily: "'JetBrains Mono', monospace" }}>
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
                            <div style={{ fontSize: 13, fontWeight: 700, color: avgReturn > 0 ? '#16A34A' : '#DC2626', fontFamily: "'JetBrains Mono', monospace" }}>
                              {avgReturn > 0 ? '+' : ''}{avgReturn.toFixed(1)}%
                            </div>
                          ) : (
                            <span style={{ color: '#D1D5DB', fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 14px', fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
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

function AlertsPage({ trades, tradesLoading, watchlistTickers }) {
  watchlistTickers = watchlistTickers || new Set();
  const recentAlerts = useMemo(() => {
    return trades
      .filter(t => {
        const type = (t.transaction_type || '').toUpperCase();
        return (type === 'BUY' || type === 'PURCHASE') && t.total_value;
      })
      .sort((a, b) => {
        // Watchlist first, then cluster buys, then by date/value
        const aWatch = watchlistTickers.has(a.ticker) ? 1 : 0;
        const bWatch = watchlistTickers.has(b.ticker) ? 1 : 0;
        if (bWatch !== aWatch) return bWatch - aWatch;
        const aSignal = (a.is_cluster_buy || a.is_pre_earnings) ? 1 : 0;
        const bSignal = (b.is_cluster_buy || b.is_pre_earnings) ? 1 : 0;
        if (bSignal !== aSignal) return bSignal - aSignal;
        if (b.transaction_date > a.transaction_date) return 1;
        if (b.transaction_date < a.transaction_date) return -1;
        return Number(b.total_value) - Number(a.total_value);
      })
      .slice(0, 30);
  }, [trades, watchlistTickers]);

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
              const urgent    = isHighValue(row);
              const isWatch   = watchlistTickers.has(row.ticker);
              const isCluster = row.is_cluster_buy;
              const name      = row.insider_name && row.insider_name !== 'Not disclosed'
                ? row.insider_name : (row.via_entity || 'Insider');

              const accentColor = isWatch ? '#F59E0B' : isCluster ? ACCENT : urgent ? '#F59E0B' : '#E2E4E9';
              const borderColor = isWatch ? '#FDE68A' : isCluster ? '#C7D2FE' : urgent ? '#FDE68A' : '#E8E9EE';

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
                      {urgent && (
                        <span style={{ fontSize: 11, fontWeight: 600, background: '#FEF9C3', color: '#92400E', borderRadius: 4, padding: '1px 7px' }}>
                          High-Value Buy
                        </span>
                      )}
                      <SignalBadges t={row} />
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>{timeAgo(row.transaction_date)}</span>
                      <Flag code={row.country_code} />
                    </div>
                    <div style={{ fontSize: 13, color: '#374151' }}>
                      <strong>{name}</strong>
                      {row.insider_role ? ` (${row.insider_role})` : ''}
                      {' '}bought{' '}
                      <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{formatValue(row.total_value, row.currency)}</strong>
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
    <div style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
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
    <main style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>
      {/* Hero */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '72px 40px 60px', textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          borderRadius: 20, padding: '4px 14px', fontSize: 11,
          color: '#15803D', fontFamily: "'JetBrains Mono', monospace",
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
          background: '#f8f8f8', border: '1px solid #f0f0f0', borderRadius: 9, padding: 3,
        }}>
          {['monthly', 'annual'].map(b => (
            <button key={b} onClick={() => setBilling(b)} style={{
              padding: '8px 22px', borderRadius: 7, border: 'none', cursor: 'pointer',
              background: billing === b ? '#fff' : 'transparent',
              color: billing === b ? '#111318' : '#9CA3AF',
              fontWeight: billing === b ? 600 : 400, fontSize: 13,
              fontFamily: "'Inter', sans-serif", transition: 'all 0.15s',
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
                  border: '1.5px solid ' + (isH ? ACCENT + '55' : isHov ? '#d0d0d0' : '#f0f0f0'),
                  borderRadius: 14, overflow: 'hidden',
                  boxShadow: isH
                    ? '0 0 0 3px ' + ACCENT + '0F, 0 16px 48px rgba(0,0,0,0.09)'
                    : isHov ? '0 6px 20px rgba(0,0,0,0.07)' : 'none',
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
                    color: isH ? ACCENT : '#9CA3AF', marginBottom: 5, fontFamily: "'JetBrains Mono', monospace",
                  }}>{plan.tier}</div>
                  <div style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 24 }}>{plan.tagline}</div>

                  <div style={{ marginBottom: 24, paddingBottom: 22, borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, marginBottom: 4 }}>
                      <span style={{ fontSize: 28, fontWeight: 700, color: '#6B7280', marginBottom: 6, lineHeight: 1, fontFamily: "'JetBrains Mono', monospace" }}>€</span>
                      <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.04em', color: '#0C0F1A', lineHeight: 1, fontFamily: "'JetBrains Mono', monospace" }}>
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
                    border: isH ? 'none' : '1.5px solid #f0f0f0',
                    background: isH ? ACCENT : '#fff',
                    color: isH ? '#fff' : '#111318',
                    fontWeight: 600, fontSize: 14, cursor: 'pointer',
                    fontFamily: "'Inter', sans-serif", transition: 'all 0.15s',
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
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>
              Proof of Performance
            </div>
            <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.025em', color: '#0C0F1A' }}>The data speaks for itself.</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            {proofItems.map((item, i) => (
              <div key={i} style={{
                background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
                padding: '22px 20px',
              }}>
                <div style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>{item.label}</div>
                <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', color: item.color, fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>{item.value}</div>
                <div style={{ fontSize: 12, color: '#9CA3AF' }}>{item.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Feature grid */}
        <div style={{ marginBottom: 64 }}>
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>Full Comparison</div>
            <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.025em', color: '#0C0F1A' }}>Everything, side by side.</h2>
          </div>
          <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', borderBottom: '2px solid #f0f0f0' }}>
              <div style={{ padding: '16px 20px' }} />
              {['The Analyst', 'The Strategist', 'The Terminal'].map((name, i) => (
                <div key={i} style={{
                  padding: '16px 20px', textAlign: 'center',
                  borderLeft: '1px solid #f0f0f0',
                  background: i === 1 ? ACCENT + '06' : 'transparent',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: i === 1 ? ACCENT : '#374151', fontFamily: "'JetBrains Mono', monospace" }}>{name}</div>
                  {i === 1 && <div style={{ fontSize: 10, color: ACCENT + 'AA', marginTop: 3 }}>Recommended</div>}
                </div>
              ))}
            </div>
            {PLAN_FEATURES_GRID.map((section, si) => (
              <div key={si}>
                <div style={{ padding: '10px 20px', background: '#fafafa', borderTop: si > 0 ? '2px solid #f0f0f0' : 'none', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>{section.category}</span>
                </div>
                {section.rows.map((row, ri) => (
                  <div key={ri} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ padding: '11px 20px', fontSize: 13, color: '#374151' }}>{row.label}</div>
                    {[row.analyst, row.strategist, row.terminal].map((val, ci) => (
                      <div key={ci} style={{
                        padding: '11px 20px', textAlign: 'center',
                        borderLeft: '1px solid #f0f0f0',
                        background: ci === 1 ? ACCENT + '04' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {val === true ? <Check />
                          : val === false ? <Dash />
                          : <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', fontWeight: 500 }}>{val}</span>}
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
    try {
      const saved = localStorage.getItem('ia_page') || 'dashboard';
      // 'company' cannot be restored on reload (selectedCompany is transient state)
      return saved === 'company' ? 'dashboard' : saved;
    } catch { return 'dashboard'; }
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
  const [navStack, setNavStack] = useState([]); // { page, selectedInsider, selectedCompany, label }

  const [tradeSort, setTradeSort] = useState({ by: 'transaction_date', dir: 'desc' });
  const [buybackSort, setBuybackSort] = useState({ by: 'announced_date', dir: 'desc' });
  const [watchlist, setWatchlist] = useState(WATCHLIST_FALLBACK);
  const [selectedCompany, setSelectedCompany] = useState(null); // { ticker, company, countryCode, yahooTicker }

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
    // Load watchlist from Supabase (overrides hardcoded fallback when DB has entries)
    supabase.from('watchlist').select('*').order('created_at', { ascending: true }).then(({ data }) => {
      if (data && data.length > 0) setWatchlist(data);
    });
  }, []);

  async function addToWatchlist(stock) {
    const { error } = await supabase.from('watchlist').insert([stock]);
    if (error) return false;
    setWatchlist(prev => [...prev, stock]);
    return true;
  }

  const watchlistTickers = useMemo(() => new Set(watchlist.map(w => w.ticker)), [watchlist]);

  const countryCounts = useMemo(() => {
    const counts = {};
    for (const row of trades) {
      const c = row.country_code;
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [trades]);

  // applyFilters is a pure module-level function — no closure capture needed
  const filteredTrades = useMemo(
    () => sortRows(
      applyFilters(trades, ['company', 'ticker', 'insider_name', 'via_entity'], selectedCountries, search),
      tradeSort.by, tradeSort.dir, ['shares', 'price_per_share', 'total_value']
    ),
    [trades, selectedCountries, search, tradeSort]
  );

  const filteredBuybacks = useMemo(
    () => sortRows(
      applyFilters(buybacks, ['company', 'ticker'], selectedCountries, search),
      buybackSort.by, buybackSort.dir, ['total_value']
    ),
    [buybacks, selectedCountries, search, buybackSort]
  );

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

  // Build a human-readable back label for the CURRENT view (used when navigating away)
  function currentNavLabel() {
    if (page === 'company' && selectedCompany) return `Back to ${selectedCompany.company}`;
    if (page === 'insiders' && selectedInsider) return `Back to ${selectedInsider}`;
    if (page === 'insiders') return 'Back to leaderboard';
    if (page === 'watchlist') return 'Back to watchlist';
    return 'Back to dashboard';
  }

  function pushNav() {
    const label = currentNavLabel();
    setNavStack(prev => [...prev, { page, selectedInsider, selectedCompany, label }]);
  }

  function handleBack() {
    setNavStack(prev => {
      const last = prev[prev.length - 1];
      if (last) {
        setPage(last.page);
        setSelectedInsider(last.selectedInsider);
        setSelectedCompany(last.selectedCompany);
      } else {
        setPage('dashboard');
        setSelectedInsider(null);
        setSelectedCompany(null);
      }
      return prev.slice(0, -1);
    });
  }

  const backLabel = navStack.length > 0 ? navStack[navStack.length - 1].label : 'Back to dashboard';

  function handleInsiderClick(name) {
    pushNav();
    setSelectedInsider(name);
    setPage('insiders');
  }

  function handleCompanyClick(ticker, company, countryCode) {
    pushNav();
    const wl = watchlist.find(w => w.ticker === ticker && w.country_code === countryCode);
    setSelectedCompany({ ticker, company, countryCode, yahooTicker: wl?.yahoo_ticker || null });
    setPage('company');
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#ffffff' }}>
      <TopBar page={page} setPage={p => { setPage(p); setNavStack([]); setSelectedInsider(null); setSelectedCompany(null); }} search={search} setSearch={setSearch} />
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
            onCompanyClick={handleCompanyClick}
          />
        )}
        {page === 'watchlist' && (
          <WatchlistPage
            trades={trades}
            tradesLoading={tradesLoading}
            buybacks={buybacks}
            watchlist={watchlist}
            watchlistTickers={watchlistTickers}
            addToWatchlist={addToWatchlist}
            onInsiderClick={handleInsiderClick}
            onCompanyClick={handleCompanyClick}
          />
        )}
        {page === 'insiders' && selectedInsider ? (
          <InsiderProfilePage
            insiderName={selectedInsider}
            trades={trades}
            performance={performance}
            onBack={handleBack}
            backLabel={backLabel}
            onCompanyClick={handleCompanyClick}
          />
        ) : page === 'insiders' && (
          <InsidersPage
            trades={trades}
            performance={performance}
            tradesLoading={tradesLoading}
            perfLoading={perfLoading}
            onInsiderClick={handleInsiderClick}
            onCompanyClick={handleCompanyClick}
          />
        )}
        {page === 'alerts' && (
          <AlertsPage trades={trades} tradesLoading={tradesLoading} watchlistTickers={watchlistTickers} />
        )}
        {page === 'pricing' && <PricingPage />}
        {page === 'company' && selectedCompany && (
          <Suspense fallback={
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 13 }}>
              Loading…
            </div>
          }>
            <CompanyPage
              ticker={selectedCompany.ticker}
              company={selectedCompany.company}
              countryCode={selectedCompany.countryCode}
              yahooTicker={selectedCompany.yahooTicker}
              trades={trades}
              watchlist={watchlist}
              onBack={handleBack}
              backLabel={backLabel}
              onInsiderClick={handleInsiderClick}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
