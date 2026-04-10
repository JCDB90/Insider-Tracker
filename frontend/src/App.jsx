import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://loqmxllfjvdwamwicoow.supabase.co',
  'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

// ─── Constants ────────────────────────────────────────────────────────────────

const COUNTRY_FLAGS = {
  AT: '🇦🇹', AU: '🇦🇺', CA: '🇨🇦', CH: '🇨🇭', CZ: '🇨🇿',
  DE: '🇩🇪', DK: '🇩🇰', ES: '🇪🇸', FI: '🇫🇮', FR: '🇫🇷',
  HK: '🇭🇰', IE: '🇮🇪', IT: '🇮🇹', JP: '🇯🇵', KR: '🇰🇷',
  LU: '🇱🇺', NL: '🇳🇱', NO: '🇳🇴', PL: '🇵🇱', PT: '🇵🇹',
  SE: '🇸🇪', SG: '🇸🇬', ZA: '🇿🇦',
};

const COUNTRY_NAMES = {
  AT: 'Austria',      AU: 'Australia',   CA: 'Canada',      CH: 'Switzerland',
  CZ: 'Czech Republic', DE: 'Germany',  DK: 'Denmark',     ES: 'Spain',
  FI: 'Finland',      FR: 'France',      HK: 'Hong Kong',   IE: 'Ireland',
  IT: 'Italy',        JP: 'Japan',       KR: 'South Korea', LU: 'Luxembourg',
  NL: 'Netherlands',  NO: 'Norway',      PL: 'Poland',      PT: 'Portugal',
  SE: 'Sweden',       SG: 'Singapore',   ZA: 'South Africa',
};

const TRACKED_MARKETS = Object.keys(COUNTRY_FLAGS).sort();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', KRW: '₩',
  AUD: 'A$', CAD: 'C$', HKD: 'HK$', SGD: 'S$', ZAR: 'R',
  CHF: 'CHF\u00a0', SEK: 'SEK\u00a0', DKK: 'DKK\u00a0', NOK: 'NOK\u00a0',
  PLN: 'PLN\u00a0', CZK: 'CZK\u00a0', HUF: 'HUF\u00a0', RON: 'RON\u00a0',
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
  if (num >= 1e6) return `${sym}${(num / 1e6).toFixed(0)}M`;
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

// ─── Small components ─────────────────────────────────────────────────────────

function StatCard({ title, value, subtitle, accent, loading }) {
  return (
    <div className="bg-[#1e293b] border border-slate-700/50 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-3">{title}</p>
      {loading
        ? <div className="skeleton h-7 w-24 mb-1" />
        : <p className={`text-2xl font-bold leading-none mb-1 ${accent || 'text-slate-100'}`}>{value}</p>
      }
      <p className="text-xs text-slate-500">{subtitle}</p>
    </div>
  );
}

function SortTh({ col, sortBy, sortDir, onSort, children }) {
  const active = sortBy === col;
  return (
    <th
      onClick={() => onSort(col)}
      className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap cursor-pointer hover:text-slate-200 select-none"
    >
      <span className="inline-flex items-center gap-1.5">
        {children}
        <span className={active ? 'text-emerald-400' : 'text-slate-600'}>
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    </th>
  );
}

function StaticTh({ children }) {
  return (
    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
      {children}
    </th>
  );
}

// Renders a CSS-based flag image via flag-icons library (works on all OS/browsers)
// Docs: https://flagicons.lipis.dev  — uses ISO 3166-1 alpha-2 codes, lowercase
function Flag({ code, size = 'md' }) {
  const dims = size === 'sm'
    ? { width: 16, height: 12 }
    : { width: 20, height: 15 };
  return (
    <span
      className={`fi fi-${code.toLowerCase()}`}
      style={{ ...dims, borderRadius: 2, display: 'inline-block', flexShrink: 0 }}
      aria-label={code}
    />
  );
}

function CountryBadge({ code }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-slate-800 border border-slate-700/50 rounded-md text-xs font-semibold text-slate-300">
      <Flag code={code} size="sm" />
      {code}
    </span>
  );
}

function TypeBadge({ type }) {
  const t = (type || '').toUpperCase();
  if (t === 'BUY' || t === 'PURCHASE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <svg className="w-2 h-2" fill="currentColor" viewBox="0 0 8 8"><polygon points="4,1 7,6 1,6" /></svg>
        BUY
      </span>
    );
  }
  if (t === 'SELL' || t === 'SALE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
        <svg className="w-2 h-2" fill="currentColor" viewBox="0 0 8 8"><polygon points="1,2 7,2 4,7" /></svg>
        SELL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-slate-700/50 text-slate-400 border border-slate-600/30">
      {type || '—'}
    </span>
  );
}

function EmptyState({ onClear }) {
  return (
    <tr>
      <td colSpan={20}>
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg className="w-12 h-12 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div className="text-center">
            <p className="text-sm font-medium text-slate-400">No results found</p>
            <p className="text-xs text-slate-600 mt-1">Try adjusting your search or country filter</p>
          </div>
          <button onClick={onClear} className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
            Clear all filters
          </button>
        </div>
      </td>
    </tr>
  );
}

function SkeletonRow({ cols }) {
  const widths = [60, 140, 60, 120, 80, 60, 70, 60, 80, 60];
  return (
    <tr className="border-b border-slate-700/30">
      {widths.slice(0, cols).map((w, i) => (
        <td key={i} className="px-4 py-3">
          <div className="skeleton h-4" style={{ width: w }} />
        </td>
      ))}
    </tr>
  );
}

// ─── Insider Trades Table ─────────────────────────────────────────────────────

function InsiderTradesTable({ rows, loading, sortBy, sortDir, onSort, onClear }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-900/40">
            <SortTh col="transaction_date" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Date</SortTh>
            <SortTh col="company" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Company</SortTh>
            <SortTh col="ticker" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Ticker</SortTh>
            <SortTh col="insider_name" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Insider</SortTh>
            <StaticTh>Role</StaticTh>
            <StaticTh>Type</StaticTh>
            <SortTh col="shares" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Shares</SortTh>
            <SortTh col="price_per_share" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Price</SortTh>
            <SortTh col="total_value" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Total Value</SortTh>
            <StaticTh>Country</StaticTh>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/30">
          {loading ? (
            Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} cols={10} />)
          ) : rows.length === 0 ? (
            <EmptyState onClear={onClear} />
          ) : (
            rows.map((row, i) => (
              <tr key={row.id ?? i} className="hover:bg-slate-700/20 transition-colors cursor-default group">
                <td className="px-4 py-2.5 text-sm text-slate-400 whitespace-nowrap tabular-nums">
                  {formatDate(row.transaction_date)}
                </td>
                <td className="px-4 py-2.5 max-w-[180px]">
                  <span className="text-sm font-medium text-slate-100 group-hover:text-white transition-colors truncate block">
                    {row.company}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-sm font-semibold text-blue-400">{row.ticker}</span>
                </td>
                <td className="px-4 py-2.5 max-w-[160px]">
                  <span className="text-sm text-slate-200 truncate block">{row.insider_name || '—'}</span>
                </td>
                <td className="px-4 py-2.5 max-w-[120px]">
                  <span className="text-xs text-slate-500 truncate block">{row.insider_role || '—'}</span>
                </td>
                <td className="px-4 py-2.5">
                  <TypeBadge type={row.transaction_type} />
                </td>
                <td className="px-4 py-2.5 text-sm text-slate-300 tabular-nums whitespace-nowrap text-right">
                  {formatShares(row.shares)}
                </td>
                <td className="px-4 py-2.5 text-sm text-slate-300 tabular-nums whitespace-nowrap text-right">
                  {formatPrice(row.price_per_share, row.currency)}
                </td>
                <td className="px-4 py-2.5 text-sm font-semibold text-slate-200 tabular-nums whitespace-nowrap text-right">
                  {formatValue(row.total_value, row.currency)}
                </td>
                <td className="px-4 py-2.5">
                  <CountryBadge code={row.country_code} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Buyback Programs Table ───────────────────────────────────────────────────

function BuybackTable({ rows, loading, sortBy, sortDir, onSort, onClear }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-900/40">
            <SortTh col="announced_date" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Date</SortTh>
            <SortTh col="company" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Company</SortTh>
            <SortTh col="ticker" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Ticker</SortTh>
            <SortTh col="country_code" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Country</SortTh>
            <StaticTh>Type</StaticTh>
            <SortTh col="total_value" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Program Size</SortTh>
            <StaticTh>Source</StaticTh>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/30">
          {loading ? (
            Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} cols={7} />)
          ) : rows.length === 0 ? (
            <EmptyState onClear={onClear} />
          ) : (
            rows.map((row, i) => (
              <tr key={row.id ?? i} className="hover:bg-slate-700/20 transition-colors cursor-default group">
                <td className="px-4 py-2.5 text-sm text-slate-400 whitespace-nowrap tabular-nums">
                  {formatDate(row.announced_date)}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm font-medium text-slate-100 group-hover:text-white transition-colors">
                    {row.company}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-sm font-semibold text-blue-400">{row.ticker}</span>
                </td>
                <td className="px-4 py-2.5">
                  <CountryBadge code={row.country_code} />
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <svg className="w-2 h-2" fill="currentColor" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" /></svg>
                    Buyback
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="text-sm font-semibold text-slate-200 tabular-nums whitespace-nowrap">
                    {formatValue(row.total_value, row.currency)}
                  </span>
                </td>
                <td className="px-4 py-2.5 max-w-[160px]">
                  <span className="text-xs text-slate-500 truncate block">{row.source}</span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // Data
  const [trades, setTrades] = useState([]);
  const [buybacks, setBuybacks] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [buybacksLoading, setBuybacksLoading] = useState(true);

  // UI state
  const [activeTab, setActiveTab] = useState('trades'); // 'trades' | 'buybacks'
  const [search, setSearch] = useState('');
  const [selectedCountries, setSelectedCountries] = useState(new Set());

  // Sort — separate per tab
  const [tradeSort, setTradeSort] = useState({ by: 'transaction_date', dir: 'desc' });
  const [buybackSort, setBuybackSort] = useState({ by: 'announced_date', dir: 'desc' });

  // Fetch both tables on mount
  useEffect(() => {
    supabase.from('insider_transactions').select('*').order('transaction_date', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) setTrades(data);
        setTradesLoading(false);
      });

    supabase.from('buyback_programs').select('*').order('announced_date', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) setBuybacks(data);
        setBuybacksLoading(false);
      });
  }, []);

  // Country counts for the active tab (unfiltered by country, so checkboxes show real totals)
  const countryCounts = useMemo(() => {
    const source = activeTab === 'trades' ? trades : buybacks;
    const counts = {};
    for (const row of source) {
      const c = row.country_code;
      if (c) counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [activeTab, trades, buybacks]);

  // Filtering helpers
  function applyFilters(rows, searchKeys) {
    let result = rows;
    if (selectedCountries.size > 0) {
      result = result.filter(r => selectedCountries.has(r.country_code));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(r => searchKeys.some(k => (r[k] || '').toLowerCase().includes(q)));
    }
    return result;
  }

  const filteredTrades = useMemo(() => {
    const base = applyFilters(trades, ['company', 'ticker', 'insider_name']);
    return sortRows(base, tradeSort.by, tradeSort.dir, ['shares', 'price_per_share', 'total_value']);
  }, [trades, selectedCountries, search, tradeSort]);

  const filteredBuybacks = useMemo(() => {
    const base = applyFilters(buybacks, ['company', 'ticker']);
    return sortRows(base, buybackSort.by, buybackSort.dir, ['total_value']);
  }, [buybacks, selectedCountries, search, buybackSort]);

  // Stats
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

  // Sort handlers
  function handleTradeSort(col) {
    setTradeSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'asc' }));
  }
  function handleBuybackSort(col) {
    setBuybackSort(s => ({ by: col, dir: s.by === col ? (s.dir === 'asc' ? 'desc' : 'asc') : 'asc' }));
  }

  // Country checkbox handlers
  function toggleCountry(code) {
    setSelectedCountries(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }
  function selectAll() { setSelectedCountries(new Set(TRACKED_MARKETS)); }
  function clearAll() { setSelectedCountries(new Set()); }

  function clearFilters() { setSearch(''); setSelectedCountries(new Set()); }

  const isLoading = activeTab === 'trades' ? tradesLoading : buybacksLoading;
  const activeRows = activeTab === 'trades' ? filteredTrades : filteredBuybacks;
  const hasFilters = search.trim() || selectedCountries.size > 0;

  const searchPlaceholder = activeTab === 'trades'
    ? 'Search company, ticker, or insider…'
    : 'Search company or ticker…';

  return (
    <div
      className="bg-[#0f172a] text-slate-100"
      style={{ fontFamily: 'Inter, system-ui, -apple-system, sans-serif', minHeight: '100vh' }}
    >
      {/* ── Sidebar ── */}
      <aside
        className="bg-[#0b1120] border-r border-slate-800 flex flex-col overflow-y-auto"
        style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 224, zIndex: 40 }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-emerald-500 rounded-lg flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-100 leading-none">Insider Tracker</p>
              <p className="text-[10px] text-emerald-500 font-medium mt-0.5">BETA</p>
            </div>
          </div>
        </div>

        {/* Markets filter */}
        <div className="flex-1 flex flex-col min-h-0 px-4 py-4">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3 shrink-0">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Markets</span>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAll}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                All
              </button>
              <span className="text-slate-700">·</span>
              <button
                onClick={clearAll}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Country list */}
          <div className="space-y-0.5 overflow-y-auto flex-1">
            {TRACKED_MARKETS.map(code => {
              const count = countryCounts[code] || 0;
              const checked = selectedCountries.has(code);
              return (
                <label
                  key={code}
                  className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    checked ? 'bg-slate-800' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleCountry(code)}
                    className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  <Flag code={code} />
                  <span className={`text-xs font-medium flex-1 truncate ${checked ? 'text-slate-200' : 'text-slate-400'}`}>
                    {COUNTRY_NAMES[code] || code}
                  </span>
                  <span className={`text-xs tabular-nums ${count > 0 ? 'text-slate-500' : 'text-slate-700'}`}>
                    {count}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
            <span className="text-xs text-slate-500">Live data</span>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex flex-col min-h-screen" style={{ marginLeft: 224 }}>

        {/* Top bar */}
        <header className="sticky top-0 z-30 bg-[#0f172a] border-b border-slate-800 px-6 py-3 flex items-center gap-4">
          {/* Search */}
          <div className="relative" style={{ width: 280 }}>
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-slate-800/60 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-slate-500 transition-colors"
            />
          </div>

          {/* Tab switcher */}
          <div className="flex items-center bg-slate-800/70 border border-slate-700/50 rounded-lg p-1 gap-1">
            <TabButton
              active={activeTab === 'trades'}
              onClick={() => setActiveTab('trades')}
              count={tradesLoading ? null : trades.length}
            >
              Insider Trades
            </TabButton>
            <TabButton
              active={activeTab === 'buybacks'}
              onClick={() => setActiveTab('buybacks')}
              count={buybacksLoading ? null : buybacks.length}
            >
              Buyback Programs
            </TabButton>
          </div>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Clear filters
              </button>
            )}
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Updated daily
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 space-y-5">

          {/* Stats row — switches with tab */}
          {activeTab === 'trades' ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Total Trades" loading={tradesLoading}
                value={tradeStats.total.toLocaleString()}
                subtitle="All tracked insider transactions"
              />
              <StatCard
                title="Insider Buys" loading={tradesLoading}
                value={tradeStats.buys.toLocaleString()}
                accent="text-emerald-400"
                subtitle="Purchase transactions"
              />
              <StatCard
                title="Insider Sells" loading={tradesLoading}
                value={tradeStats.sells.toLocaleString()}
                accent="text-red-400"
                subtitle="Sale transactions"
              />
              <StatCard
                title="Total Value" loading={tradesLoading}
                value={formatValue(tradeStats.totalVal, 'EUR')}
                subtitle="Aggregate transaction value"
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Total Programs" loading={buybacksLoading}
                value={buybackStats.total.toLocaleString()}
                subtitle="Across all tracked markets"
              />
              <StatCard
                title="Markets Tracked" loading={buybacksLoading}
                value={buybackStats.markets}
                subtitle="Active regulatory sources"
              />
              <StatCard
                title="Latest Filing" loading={buybacksLoading}
                value={formatDate(buybackStats.latest)}
                subtitle="Most recent announcement"
              />
              <StatCard
                title="Avg Program Size" loading={buybacksLoading}
                value={formatValue(buybackStats.avgSize, 'EUR')}
                subtitle="Mean total value"
              />
            </div>
          )}

          {/* Data table card */}
          <div className="bg-[#1e293b] border border-slate-700/50 rounded-xl overflow-hidden">
            {/* Card header */}
            <div className="px-5 py-3.5 border-b border-slate-700/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-slate-100">
                  {activeTab === 'trades' ? 'Insider Transactions' : 'Buyback Programs'}
                </h2>
                {!isLoading && (
                  <span className="px-2 py-0.5 bg-slate-700/60 rounded-full text-xs font-medium text-slate-300">
                    {activeRows.length.toLocaleString()}
                  </span>
                )}
              </div>
              {selectedCountries.size > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">
                    {selectedCountries.size} {selectedCountries.size === 1 ? 'market' : 'markets'} selected
                  </span>
                </div>
              )}
            </div>

            {/* Table — rendered for both tabs, displayed based on activeTab */}
            {activeTab === 'trades' ? (
              <InsiderTradesTable
                rows={filteredTrades}
                loading={tradesLoading}
                sortBy={tradeSort.by}
                sortDir={tradeSort.dir}
                onSort={handleTradeSort}
                onClear={clearFilters}
              />
            ) : (
              <BuybackTable
                rows={filteredBuybacks}
                loading={buybacksLoading}
                sortBy={buybackSort.by}
                sortDir={buybackSort.dir}
                onSort={handleBuybackSort}
                onClear={clearFilters}
              />
            )}

            {/* Table footer */}
            {!isLoading && activeRows.length > 0 && (
              <div className="px-5 py-3 border-t border-slate-700/50 flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  Showing{' '}
                  <span className="text-slate-300 font-medium">{activeRows.length.toLocaleString()}</span>
                  {' '}of{' '}
                  <span className="text-slate-300 font-medium">
                    {(activeTab === 'trades' ? trades.length : buybacks.length).toLocaleString()}
                  </span>{' '}
                  {activeTab === 'trades' ? 'transactions' : 'programs'}
                </p>
                <p className="text-xs text-slate-600">Sourced from regulatory filings</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Tab Button ───────────────────────────────────────────────────────────────

function TabButton({ active, onClick, count, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium transition-all ${
        active
          ? 'bg-slate-700 text-white shadow-sm'
          : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {children}
      {count != null && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full tabular-nums ${
          active ? 'bg-slate-600 text-slate-200' : 'bg-slate-700/60 text-slate-500'
        }`}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}
