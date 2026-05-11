import { useState, useEffect, useMemo, useRef } from 'react';
import { createChart, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { supabase } from './supabase.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = '#0f1117';

const CURRENCY_SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', KRW: '₩',
  CHF: 'CHF ', SEK: 'SEK ', DKK: 'DKK ', NOK: 'NOK ',
};

const COUNTRY_FLAGS = {
  BE:'🇧🇪',CH:'🇨🇭',DE:'🇩🇪',DK:'🇩🇰',
  ES:'🇪🇸',FI:'🇫🇮',FR:'🇫🇷',GB:'🇬🇧',
  IT:'🇮🇹',KR:'🇰🇷',NL:'🇳🇱',NO:'🇳🇴',
  SE:'🇸🇪',
};

const COUNTRY_YAHOO_SUFFIX = {
  SE:'.ST', DK:'.CO', FI:'.HE', NO:'.OL', DE:'.DE', FR:'.PA',
  NL:'.AS', BE:'.BR', IT:'.MI', ES:'.MC',
  CH:'.SW', GB:'.L',
};

// ─── Signal icon helpers (shared with App.jsx concept, inlined here) ─────────

const IcoTrendDown = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </svg>
);
const IcoRepeat = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const IcoUsers = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const IcoCalendar = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

function TxSignalBadges({ t, blackout }) {
  const badges = [];
  if (t.is_price_dip) badges.push({
    key: 'dip', icon: <IcoTrendDown />, title: `Bought after ${t.price_drawdown != null ? (Number(t.price_drawdown)*100).toFixed(0)+'%' : '10%+'} price decline`,
    color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA',
  });
  if (t.is_repetitive_buy) badges.push({
    key: 'rep', icon: <IcoRepeat />, title: 'Same insider made multiple purchases within 14 days',
    color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB',
  });
  if (t.is_cluster_buy) badges.push({
    key: 'cluster', icon: <IcoUsers />, title: 'Multiple insiders at this company bought within 14 days',
    color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE',
  });
  if (t.is_pre_earnings || blackout?.isNear) badges.push({
    key: 'earn', icon: <IcoCalendar />,
    title: blackout?.isNear
      ? `Purchased ${blackout.daysBefore} days before earnings (${fmtDateShort(blackout.earningsDate)})`
      : 'Purchased 30–45 days before a typical earnings blackout period',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A',
  });

  if (badges.length === 0) return <span style={{ fontSize: 11, color: '#D1D5DB' }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {badges.map(b => (
        <span key={b.key} title={b.title} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, borderRadius: 4,
          background: b.bg, border: '1px solid ' + b.border,
          color: b.color, flexShrink: 0, cursor: 'default',
        }}>{b.icon}</span>
      ))}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(currency) {
  return CURRENCY_SYMBOLS[currency] ?? (currency ? currency + ' ' : '€');
}

function fmtVal(value, currency = 'EUR') {
  if (!value || isNaN(value)) return '—';
  const n = Number(value);
  if (n === 0) return '—';
  const s = sym(currency);
  if (n >= 1e9) return `${s}${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${s}${(n / 1e6).toFixed(1)}M`;
  return `${s}${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPrice(value, currency = 'EUR') {
  if (value == null || isNaN(value)) return '—';
  const n = Number(value);
  const dec = n < 1 ? 4 : 2;
  return `${sym(currency)}${n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

function fmtShares(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtDateShort(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Build an ordered list of Yahoo Finance symbol candidates to try.
 * The proxy (api/yahoo-chart.js) tries each in sequence and returns the
 * first one that has actual price data.
 *
 * Handles:
 *  - Empty ticker (ABEO FR stored with no ticker) → derives from company name
 *  - Swedish B-shares (ELANDE stored for Elanders → tries ELAN-B.ST, ELANB.ST)
 *  - Share-class suffix stripping (MIDS-B → MIDS.ST)
 *  - 4-char truncation (MIDSON → MIDS.ST)
 */
function buildYahooSymbolCandidates(ticker, countryCode, yahooTicker, company) {
  if (yahooTicker) return [yahooTicker];

  // ISINs stored as tickers (12-char alphanumeric) will never resolve on Yahoo
  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;
  if (ticker && ISIN_RE.test(ticker)) return [];

  // Korean stocks use 6-digit KRX codes; Yahoo requires .KS (KOSPI) or .KQ (KOSDAQ)
  if (countryCode === 'KR' && ticker) {
    return [ticker + '.KS', ticker + '.KQ'];
  }

  const sfx = COUNTRY_YAHOO_SUFFIX[countryCode] || '';

  // When scraper stored no ticker, derive from first word of company name
  const derived = (!ticker && company)
    ? company.replace(/\s+(AB|SA|NV|BV|PLC|SE|SAS|AG|GmbH)[\s.]*$/i, '').trim()
        .split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '')
    : null;

  const base = ticker || derived || '';
  if (!base) return [];

  const bare = base.replace(/[-.].*$/, ''); // MIDS-B → MIDS, ELAN-B → ELAN

  const candidates = [
    base + sfx,                // primary: stored ticker + suffix
    bare + sfx,                // bare without share-class suffix
    base.slice(0, 4) + sfx,   // first 4 chars (MIDSON → MIDS.ST)
  ];

  // Swedish B-shares: scraper often stores name-truncated tickers (e.g. ELANDE
  // instead of ELAN-B). Try both hyphenated and concatenated B-share variants.
  if (countryCode === 'SE' && !base.includes('-')) {
    const root = base.replace(/[BE]$/, ''); // ELANDE → ELAND, ELANB → ELAN
    candidates.push(
      root + '-B' + sfx,     // ELAN-B.ST
      root + 'B' + sfx,      // ELANB.ST
      root.slice(0, 4) + '-B' + sfx, // ELAN-B.ST from truncated root
    );
  }

  // NL-registered companies are often cross-listed on Paris, Milan, Brussels, or
  // Nasdaq rather than Amsterdam. Try all common EU exchanges + bare (NYSE/Nasdaq).
  if (countryCode === 'NL') {
    candidates.push(
      base + '.PA',           // Euronext Paris (STMicro STMPA.PA, Euronext ENX.PA)
      base + '.MI',           // Borsa Milan (Ferrari RACE.MI, Campari CPR.MI)
      base + '.BR',           // Euronext Brussels (argenx ARGX.BR)
      base,                   // Nasdaq/NYSE bare (argenx ARGX, Ferrari RACE)
      bare + '.PA',
      bare + '.MI',
      bare + '.BR',
      bare,
    );
  }

  // No bare (no-suffix) fallback when exchange suffix is known — prevents
  // e.g. "AB" resolving to AllianceBernstein on NYSE.
  if (!sfx) candidates.push(base);

  return [...new Set(candidates)].filter(Boolean);
}

/**
 * Check whether txDate falls in the 30-60 day window before any known earnings date.
 * This captures insiders buying just BEFORE the pre-earnings blackout begins.
 *   < 30 days before: too close — likely already inside the blackout period
 *  30–45 days before: prime signal window — insider buying before blackout starts ✓
 *   > 60 days before: too early — not meaningfully close to earnings
 *
 * Only fires when earningsDates is non-empty so companies with no data
 * show nothing rather than a wrong badge.
 */
function checkEarningsBlackout(txDate, earningsDates) {
  if (!earningsDates || earningsDates.length === 0) return { isNear: false };
  const txMs    = new Date(txDate).getTime();
  const todayMs = Date.now();
  let best = null;
  for (const ed of earningsDates) {
    if (new Date(ed).getTime() < todayMs) continue;
    const daysBefore = (new Date(ed).getTime() - txMs) / 86400000;
    // Window: 30–60 days before earnings
    if (daysBefore >= 30 && daysBefore <= 60) {
      if (!best || daysBefore < best.daysBefore) best = { daysBefore: Math.round(daysBefore), earningsDate: ed };
    }
  }
  return best ? { isNear: true, ...best } : { isNear: false };
}

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function getPriceRatio(txPrice, marketPrice) {
  if (!txPrice || !marketPrice || marketPrice === 0) return null;
  return Number(txPrice) / Number(marketPrice);
}

function findChartPrice(chartData, dateStr) {
  if (!chartData.length) return null;
  const exact = chartData.find(p => p.time === dateStr);
  if (exact) return exact.value;
  const target = new Date(dateStr).getTime();
  let best = null, bestDiff = Infinity;
  for (const p of chartData) {
    const diff = Math.abs(new Date(p.time).getTime() - target);
    if (diff < bestDiff && diff <= 7 * 86400000) { bestDiff = diff; best = p.value; }
  }
  return best;
}

// ─── StockChart ───────────────────────────────────────────────────────────────

function StockChart({ data, trades, earningsDates, triedSymbols }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);

  useEffect(() => {
    if (!containerRef.current || data.length === 0) return;

    const el = containerRef.current;
    const chart = createChart(el, {
      width:  el.offsetWidth,
      height: 320,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#6B7280',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#f0f0f0', style: 1 },
        horzLines: { color: '#f0f0f0', style: 1 },
      },
      rightPriceScale: { borderColor: '#f0f0f0', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#f0f0f0', fixLeftEdge: true, fixRightEdge: true, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
    });

    const series = chart.addSeries(LineSeries, {
      color: ACCENT,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    series.setData(data);

    // Build markers with price-aware positioning:
    //   • Transaction price within 15% of market → 'inBar' (dot ON the line)
    //   • Transaction price < 85% of market      → 'belowBar' (option exercise / deep discount)
    //   • Transaction price > 115% of market     → 'aboveBar'
    //   • No price data available                → default below/above by side
    const minTime = data[0]?.time;
    const maxTime = data[data.length - 1]?.time;

    const insiderMarkers = trades
      .filter(t => t.transaction_date >= minTime && t.transaction_date <= maxTime)
      .map(t => {
        const isBuy = t.transaction_type === 'BUY';
        let position = isBuy ? 'belowBar' : 'aboveBar';

        const marketPrice = findChartPrice(data, t.transaction_date);
        if (marketPrice && t.price_per_share && t.price_per_share > 0) {
          const ratio = Number(t.price_per_share) / marketPrice;
          if (ratio >= 0.85 && ratio <= 1.15) position = 'inBar';
          else if (ratio < 0.85)              position = 'belowBar';
          else                                position = 'aboveBar';
        }

        return {
          time:  t.transaction_date,
          position,
          color: isBuy ? '#16A34A' : '#DC2626',
          shape: 'circle',
          text:  '',
          size:  1.2,
        };
      });

    // Earnings date markers — small amber square, no text
    const earningsMarkers = (earningsDates || [])
      .filter(ed => ed >= minTime && ed <= maxTime)
      .map(ed => ({
        time:     ed,
        position: 'inBar',
        color:    '#F59E0B',
        shape:    'square',
        text:     '',
        size:     1,
      }));

    const allMarkers = [...insiderMarkers, ...earningsMarkers]
      .sort((a, b) => a.time.localeCompare(b.time));

    // v5 API: createSeriesMarkers() replaces series.setMarkers()
    if (allMarkers.length) createSeriesMarkers(series, allMarkers);

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (el && chartRef.current) chartRef.current.applyOptions({ width: el.offsetWidth });
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [data, trades, earningsDates]);

  if (data.length === 0) {
    return (
      <div ref={containerRef} style={{
        height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: '#fafafa', borderRadius: 10, border: '1px solid #f0f0f0', gap: 6,
      }}>
        <span style={{ color: '#9CA3AF', fontSize: 13 }}>Chart data unavailable</span>
        {triedSymbols?.length > 0 && (
          <span style={{ color: '#D1D5DB', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            Tried: {triedSymbols.slice(0, 4).join(', ')}
          </span>
        )}
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', borderRadius: 10, overflow: 'hidden', border: '1px solid #f0f0f0' }} />;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10,
      padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        {label}
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '-0.02em', color: color || '#111318', lineHeight: 1,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── CompanyPage ──────────────────────────────────────────────────────────────

export default function CompanyPage({
  ticker, company, countryCode, yahooTicker,
  trades, watchlist, onBack, onInsiderClick, backLabel, access,
}) {
  const [chartData,     setChartData]     = useState([]);
  const [chartRange,    setChartRange]    = useState('1y');
  const [priceLoading,  setPriceLoading]  = useState(true);
  const [currentPrice,  setCurrentPrice]  = useState(null);
  const [priceChange,   setPriceChange]   = useState(null);
  const [priceCurrency, setPriceCurrency] = useState('EUR');
  const [chartError,    setChartError]    = useState(false);
  const [resolvedSymbol, setResolvedSymbol] = useState(null);

  // earnings_calendar rows from Supabase — null = not yet loaded, [] = loaded but empty
  const [earningsDates,  setEarningsDates]  = useState(null);
  const [earningsNoData, setEarningsNoData] = useState(false); // true once fetch complete + empty

  // Filter all transactions for this company.
  // When both ticker and countryCode are known, require both to match — prevents
  // cross-listing collisions (e.g. VID = Vidrala ES AND Videndum GB).
  const companyTrades = useMemo(() =>
    trades
      .filter(t => {
        if (ticker && countryCode) {
          return t.ticker === ticker && t.country_code === countryCode;
        }
        return (t.ticker && t.ticker === ticker) || t.company === company;
      })
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date)),
    [trades, ticker, company, countryCode]
  );

  // Build ordered list of Yahoo Finance symbol candidates (proxy tries each in sequence)
  const yahooSymbols = useMemo(() => {
    const wl = watchlist?.find(w => w.ticker === ticker && w.country_code === countryCode);
    const override = yahooTicker || wl?.yahoo_ticker || null;
    return buildYahooSymbolCandidates(ticker, countryCode, override, company);
  }, [ticker, countryCode, yahooTicker, watchlist]);

  // ── Fetch earnings dates from Supabase ──────────────────────────────────────
  useEffect(() => {
    if (!ticker) return;
    setEarningsDates(null);
    setEarningsNoData(false);

    supabase
      .from('earnings_calendar')
      .select('earnings_date, source')
      .eq('ticker', ticker)
      .order('earnings_date', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setEarningsDates([]);
          setEarningsNoData(true);
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const dates = (data || [])
          .map(r => r.earnings_date)
          // Only include future dates — burst predictions can lag reality
          .filter(d => d > today);
        setEarningsDates(dates);
        setEarningsNoData(dates.length === 0);
      });
  }, [ticker]);

  // ── Fetch chart data from Yahoo proxy (tries multiple symbol candidates) ────
  useEffect(() => {
    if (!yahooSymbols.length) { setPriceLoading(false); setChartError(true); return; }

    setPriceLoading(true);
    setChartError(false);
    setResolvedSymbol(null);

    // Pass all candidates; proxy tries them in order and returns first with data
    const symbolsParam = yahooSymbols.map(encodeURIComponent).join(',');
    fetch(`/api/yahoo-chart?symbols=${symbolsParam}&range=${chartRange}&interval=1d`)
      .then(r => {
        if (!r.ok) return Promise.reject(r.status);
        const sym = r.headers.get('X-Resolved-Symbol');
        if (sym) setResolvedSymbol(sym);
        return r.json();
      })
      .then(json => {
        const result = json?.chart?.result?.[0];
        if (!result) { setChartError(true); return; }

        const timestamps = result.timestamp || [];
        const closes = result.indicators?.adjclose?.[0]?.adjclose
                    || result.indicators?.quote?.[0]?.close || [];
        setPriceCurrency(result.meta?.currency || 'USD');

        const points = [];
        for (let i = 0; i < timestamps.length; i++) {
          const v = closes[i];
          if (v != null && v > 0) {
            points.push({
              time:  new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
              value: Math.round(v * 10000) / 10000,
            });
          }
        }
        setChartData(points);

        if (points.length >= 2) {
          const last = points[points.length - 1].value;
          const prev = points[points.length - 2].value;
          setCurrentPrice(last);
          setPriceChange(((last - prev) / prev) * 100);
        } else if (points.length === 1) {
          setCurrentPrice(points[0].value);
          setPriceChange(null);
        }
      })
      .catch(() => setChartError(true))
      .finally(() => setPriceLoading(false));
  }, [yahooSymbols, chartRange]);

  // ── Derived earnings values ──────────────────────────────────────────────────
  const { nextEarnings, prevEarnings } = useMemo(() => {
    if (!earningsDates?.length) return { nextEarnings: null, prevEarnings: null };
    const today = new Date().toISOString().slice(0, 10);
    const future = earningsDates.filter(d => d >= today);
    const past   = earningsDates.filter(d => d <  today);
    return {
      nextEarnings: future.length ? future[0]            : null,
      prevEarnings: past.length   ? past[past.length - 1] : null,
    };
  }, [earningsDates]);

  const daysToEarnings = nextEarnings ? daysUntil(nextEarnings) : null;

  // ── KPI calculations (last 6 months) ────────────────────────────────────────
  const kpis = useMemo(() => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 6);
    const recent = companyTrades.filter(t => new Date(t.transaction_date) >= cutoff);
    const buys   = recent.filter(t => t.transaction_type === 'BUY');
    const sells  = recent.filter(t => t.transaction_type === 'SELL');
    const largest = [...companyTrades]
      .filter(t => t.total_value)
      .sort((a, b) => Number(b.total_value) - Number(a.total_value))[0];
    const sentimentLabel =
      buys.length === 0 && sells.length === 0 ? 'No data'
      : buys.length > sells.length * 2         ? 'Strong Buy'
      : buys.length > sells.length             ? 'Buy'
      : sells.length > buys.length * 2         ? 'Strong Sell'
      : sells.length > buys.length             ? 'Sell'
                                               : 'Neutral';
    const sentimentColor =
      sentimentLabel.includes('Buy')  ? '#16A34A'
      : sentimentLabel.includes('Sell') ? '#DC2626'
                                        : '#6B7280';
    return { buys: buys.length, sells: sells.length, sentimentLabel, sentimentColor, largest };
  }, [companyTrades]);

  // ── Render helpers ───────────────────────────────────────────────────────────
  const RANGES = [
    { key: '1mo', label: '1M' },
    { key: '3mo', label: '3M' },
    { key: '6mo', label: '6M' },
    { key: '1y',  label: '1Y' },
  ];

  const flag           = COUNTRY_FLAGS[countryCode] || '';
  const changePositive = priceChange != null && priceChange >= 0;
  const earningsReady  = earningsDates !== null; // null = loading, [] = loaded

  // Count real pre-earnings buys for the research note
  const preEarningsBuys = useMemo(() =>
    earningsDates?.length
      ? companyTrades.filter(t =>
          t.transaction_type === 'BUY' &&
          checkEarningsBlackout(t.transaction_date, earningsDates).isNear
        )
      : [],
    [companyTrades, earningsDates]
  );

  return (
    <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0, background: '#ffffff' }}>

      {/* Back */}
      <button onClick={onBack} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 20,
        background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
        fontSize: 13, color: '#6B7280', fontFamily: "'Inter', sans-serif",
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {backLabel || 'Back'}
      </button>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
        padding: '20px 24px', marginBottom: 24,
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10, flexShrink: 0,
          background: ACCENT + '15', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 20,
        }}>
          {flag}
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#111318', letterSpacing: '-0.02em' }}>
            {company}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: '#6B7280' }}>{ticker}</span>
            <span style={{ color: '#D1D5DB' }}>·</span>
            <span style={{ fontSize: 13, color: '#9CA3AF' }}>{countryCode}</span>
          </div>
        </div>
      </div>

      {/* ── Section 1: Chart ──────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
        padding: '20px 24px', marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111318', marginBottom: 2 }}>Stock Price</h2>
            <p style={{ fontSize: 12, color: '#9CA3AF' }}>
              {chartData.length > 0
                ? `${chartData.length} trading days · ▲▼ insider trades${earningsDates?.length ? ' · 📅 earnings dates' : ''}${resolvedSymbol && resolvedSymbol !== yahooSymbols[0] ? ` · ${resolvedSymbol}` : ''}`
                : 'Historical price chart'}
            </p>
          </div>
          {/* Range toggles */}
          <div style={{ display: 'flex', gap: 4, background: '#f8f8f8', borderRadius: 7, padding: 3 }}>
            {RANGES.map(r => (
              <button key={r.key} onClick={() => setChartRange(r.key)} style={{
                padding: '5px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: chartRange === r.key ? 600 : 400,
                background: chartRange === r.key ? '#fff' : 'transparent',
                color: chartRange === r.key ? '#111318' : '#9CA3AF',
                boxShadow: chartRange === r.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                fontFamily: "'Inter', sans-serif", transition: 'all 0.15s',
              }}>{r.label}</button>
            ))}
          </div>
        </div>

        {priceLoading ? (
          <div style={{
            height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#fafafa', borderRadius: 10, border: '1px solid #f0f0f0',
          }}>
            <div style={{ fontSize: 13, color: '#9CA3AF' }}>Loading chart…</div>
          </div>
        ) : (
          <StockChart
            data={chartData}
            trades={companyTrades}
            earningsDates={earningsDates || []}
            triedSymbols={chartData.length === 0 ? yahooSymbols : null}
          />
        )}

        {/* Chart legend */}
        <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
          {[
            { color: '#16A34A', shape: '●', label: 'Insider buy' },
            { color: '#DC2626', shape: '●', label: 'Insider sell' },
            ...(earningsDates?.length ? [{ color: '#F59E0B', shape: '■', label: 'Earnings date' }] : []),
          ].map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ fontSize: 12, color: item.color }}>{item.shape}</span>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section 2: KPI Cards ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
        <KpiCard
          label="Insider Buys (6m)"
          value={kpis.buys}
          sub="Purchase transactions"
          color={kpis.buys > 0 ? '#16A34A' : '#9CA3AF'}
        />
        <KpiCard
          label="Insider Sells (6m)"
          value={kpis.sells}
          sub="Disposal transactions"
          color={kpis.sells > 0 ? '#DC2626' : '#9CA3AF'}
        />
        <KpiCard
          label="Sentiment"
          value={kpis.sentimentLabel}
          sub={`${kpis.buys}B / ${kpis.sells}S · last 6 months`}
          color={kpis.sentimentColor}
        />
        <KpiCard
          label="Largest Trade"
          value={kpis.largest ? fmtVal(kpis.largest.total_value, kpis.largest.currency) : '—'}
          sub={kpis.largest ? fmtDateShort(kpis.largest.transaction_date) : 'No data'}
        />
      </div>

      {/* ── Section 3–5: Transactions Table ──────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111318', marginBottom: 2 }}>
            All Insider Transactions
          </h2>
          <p style={{ fontSize: 12, color: '#9CA3AF' }}>
            {earningsDates?.length
              ? `Price analysis · signal detection · ${earningsDates.length} known earnings dates`
              : 'Price analysis · signal detection'}
          </p>
        </div>

        {companyTrades.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
            No insider transactions found for {company}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
                  {['Date','Insider','Role','Type','Shares','Price','Value','vs Market','Signal'].map(h => (
                    <th key={h} style={{
                      padding: '10px 14px',
                      textAlign: ['Shares','Price','Value'].includes(h) ? 'right' : 'left',
                      fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                      letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(access && !access.isPro ? companyTrades.slice(0, 3) : companyTrades).map((t, i) => {
                  const isBuy      = t.transaction_type === 'BUY';
                  const name       = t.insider_name && t.insider_name !== 'Not disclosed'
                    ? t.insider_name : (t.via_entity || null);
                  const mktPrice   = findChartPrice(chartData, t.transaction_date);
                  const ratio      = getPriceRatio(t.price_per_share, mktPrice);
                  const blackout   = checkEarningsBlackout(t.transaction_date, earningsDates || []);

                  let vsMarket = null;
                  if (ratio != null) {
                    if (ratio < 0.85)      vsMarket = { label: '⚠ Option / Award', color: '#F59E0B', bg: '#FFFBEB' };
                    else if (ratio > 1.15) vsMarket = { label: '⚠ Unusual price',  color: '#F59E0B', bg: '#FFFBEB' };
                    else                   vsMarket = { label: '✓ Market price',    color: '#16A34A', bg: '#F0FDF4' };
                  }

                  return (
                    <tr
                      key={t.id || i}
                      style={{ borderBottom: i < companyTrades.length - 1 ? '1px solid #f0f0f0' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      {/* Date */}
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6B7280', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                        {fmtDateShort(t.transaction_date)}
                      </td>

                      {/* Insider */}
                      <td style={{ padding: '10px 14px', maxWidth: 160, overflow: 'hidden' }}>
                        {name ? (
                          onInsiderClick ? (
                            <button onClick={() => onInsiderClick(name)} style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontWeight: 500, fontSize: 13, color: ACCENT, textAlign: 'left',
                              fontFamily: "'Inter', sans-serif",
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              maxWidth: '100%', display: 'block',
                            }}>{name}</button>
                          ) : (
                            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                          )
                        ) : (
                          <span style={{ fontSize: 12, color: '#9CA3AF' }}>Not disclosed</span>
                        )}
                        {t.via_entity && t.insider_name && (
                          <div style={{ fontSize: 11, color: '#9CA3AF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            via {t.via_entity}
                          </div>
                        )}
                      </td>

                      {/* Role */}
                      <td style={{ padding: '10px 14px', fontSize: 11, color: '#9CA3AF', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {t.insider_role || '—'}
                      </td>

                      {/* Type */}
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          display: 'inline-block',
                          fontWeight: 600, fontSize: 12, borderRadius: 4, padding: '2px 8px',
                          color:      isBuy ? '#15803D' : '#B91C1C',
                          background: isBuy ? '#F0FDF4' : '#FEF2F2',
                        }}>
                          {t.transaction_type}
                        </span>
                      </td>

                      {/* Shares */}
                      <td style={{ padding: '10px 14px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtShares(t.shares)}
                      </td>

                      {/* Price */}
                      <td style={{ padding: '10px 14px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtPrice(t.price_per_share, t.currency)}
                      </td>

                      {/* Value */}
                      <td style={{ padding: '10px 14px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtVal(t.total_value, t.currency)}
                      </td>

                      {/* vs Market */}
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        {vsMarket ? (
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, color: vsMarket.color, background: vsMarket.bg }}>
                            {vsMarket.label}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#D1D5DB' }}>—</span>
                        )}
                      </td>

                      {/* Signal badges */}
                      <td style={{ padding: '10px 14px' }}>
                        <TxSignalBadges t={t} blackout={isBuy ? blackout : null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {access && !access.isPro && companyTrades.length > 3 && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '20px', background: 'linear-gradient(to bottom, rgba(255,255,255,0.3), #fff 40%)',
                borderTop: '1px solid #f0f0f0', gap: 8,
              }}>
                <span style={{ fontSize: 22 }}>🔒</span>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>
                  {companyTrades.length - 3} more transaction{companyTrades.length - 3 !== 1 ? 's' : ''} hidden
                </div>
                <div style={{ fontSize: 12, color: '#9CA3AF' }}>Full history with Pro — from €19/month</div>
                <a href="#pricing" onClick={e => { e.preventDefault(); }} style={{
                  background: ACCENT, color: '#fff', border: 'none', borderRadius: 7,
                  padding: '7px 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  fontFamily: "'Inter', sans-serif", textDecoration: 'none', marginTop: 4,
                }}>Unlock with Pro →</a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Research note — only shown when real pre-earnings buys exist */}
      {preEarningsBuys.length > 0 && (
        <div style={{
          marginTop: 16, padding: '12px 16px',
          background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8,
          fontSize: 12, color: '#92400E', lineHeight: 1.6,
        }}>
          📅 <strong>{preEarningsBuys.length} insider buy{preEarningsBuys.length > 1 ? 's' : ''} occurred 30–60 days before a known earnings date</strong> — inside the typical pre-earnings blackout window.
          Research (Seyhun 1998, Lakonishok &amp; Lee 2001) shows CEO/CFO purchases in this window carry
          2–3× stronger predictive power than purchases at other times.
        </div>
      )}

    </main>
  );
}
