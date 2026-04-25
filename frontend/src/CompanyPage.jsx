import { useState, useEffect, useMemo, useRef } from 'react';
import { createChart, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { supabase } from './supabase.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = '#1B2CC1';

const CURRENCY_SYMBOLS = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', KRW: '₩',
  AUD: 'A$', CAD: 'C$', HKD: 'HK$', SGD: 'S$', ZAR: 'R',
  CHF: 'CHF ', SEK: 'SEK ', DKK: 'DKK ', NOK: 'NOK ',
  PLN: 'PLN ', CZK: 'CZK ',
};

const COUNTRY_FLAGS = {
  AT:'🇦🇹',BE:'🇧🇪',CA:'🇨🇦',CH:'🇨🇭',CZ:'🇨🇿',DE:'🇩🇪',DK:'🇩🇰',
  ES:'🇪🇸',FI:'🇫🇮',FR:'🇫🇷',GB:'🇬🇧',HK:'🇭🇰',IE:'🇮🇪',IT:'🇮🇹',
  JP:'🇯🇵',KR:'🇰🇷',LU:'🇱🇺',NL:'🇳🇱',NO:'🇳🇴',PL:'🇵🇱',PT:'🇵🇹',
  SE:'🇸🇪',SG:'🇸🇬',ZA:'🇿🇦',AU:'🇦🇺',
};

const COUNTRY_YAHOO_SUFFIX = {
  SE:'.ST', DK:'.CO', FI:'.HE', NO:'.OL', DE:'.DE', FR:'.PA',
  NL:'.AS', BE:'.BR', PT:'.LS', IT:'.MI', ES:'.MC', AT:'.VI',
  CH:'.SW', GB:'.L',  PL:'.WA', IE:'.IR', LU:'.LU', CZ:'.PR',
};

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
 * Handles scraper-generated tickers like "MIDSON" (from "Midsona AB")
 * where the real Yahoo symbol is "MIDS.ST" (first 4 chars).
 */
function buildYahooSymbolCandidates(ticker, countryCode, yahooTicker) {
  if (yahooTicker) return [yahooTicker];
  if (!ticker) return [];
  const sfx = COUNTRY_YAHOO_SUFFIX[countryCode] || '';
  const bare = ticker.replace(/[-.].*$/, ''); // strip share-class suffix: MIDS-B → MIDS
  const candidates = [
    ticker + sfx,              // full ticker + exchange suffix (primary)
    bare + sfx,                // bare ticker + suffix (MIDS.ST)
    ticker.slice(0, 4) + sfx, // first 4 chars (MIDS.ST for MIDSON)
    ticker,                    // bare (US cross-listed fallback)
  ];
  return [...new Set(candidates)].filter(Boolean);
}

/**
 * Check whether txDate falls in the 30-60 day window before any known earnings date.
 * This captures insiders buying just BEFORE the pre-earnings blackout begins.
 *   < 30 days before: too close — likely during the blackout period (suspicious)
 *  30–60 days before: ideal signal — insider buying before blackout starts ✓
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

function StockChart({ data, trades, earningsDates }) {
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
        fontFamily: "'DM Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#F3F4F6', style: 1 },
        horzLines: { color: '#F3F4F6', style: 1 },
      },
      rightPriceScale: { borderColor: '#E8E9EE', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#E8E9EE', fixLeftEdge: true, fixRightEdge: true, timeVisible: true },
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
    //   • Transaction price within 5% of market → 'inBar' (dot ON the line)
    //   • Transaction price < 95% of market     → 'belowBar' (option exercise / discount)
    //   • Transaction price > 105% of market    → 'aboveBar'
    //   • No price data available               → default below/above by side
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
          if (ratio >= 0.95 && ratio <= 1.05) position = 'inBar';
          else if (ratio < 0.95)              position = 'belowBar';
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
        height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#F9FAFB', borderRadius: 10, border: '1px solid #E8E9EE',
        color: '#9CA3AF', fontSize: 13,
      }}>
        Chart data unavailable for this ticker
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', borderRadius: 10, overflow: 'hidden', border: '1px solid #E8E9EE' }} />;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #E8E9EE', borderRadius: 10,
      padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        {label}
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, fontFamily: "'DM Mono', monospace",
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
  trades, watchlist, onBack, onInsiderClick,
}) {
  const [chartData,     setChartData]     = useState([]);
  const [chartRange,    setChartRange]    = useState('1y');
  const [priceLoading,  setPriceLoading]  = useState(true);
  const [currentPrice,  setCurrentPrice]  = useState(null);
  const [priceChange,   setPriceChange]   = useState(null);
  const [priceCurrency, setPriceCurrency] = useState('EUR');
  const [chartError,    setChartError]    = useState(false);

  // earnings_calendar rows from Supabase — null = not yet loaded, [] = loaded but empty
  const [earningsDates,  setEarningsDates]  = useState(null);
  const [earningsNoData, setEarningsNoData] = useState(false); // true once fetch complete + empty

  // Filter all transactions for this company
  const companyTrades = useMemo(() =>
    trades
      .filter(t => (t.ticker && t.ticker === ticker) || t.company === company)
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date)),
    [trades, ticker, company]
  );

  // Build ordered list of Yahoo Finance symbol candidates (proxy tries each in sequence)
  const yahooSymbols = useMemo(() => {
    const wl = watchlist?.find(w => w.ticker === ticker && w.country_code === countryCode);
    const override = yahooTicker || wl?.yahoo_ticker || null;
    return buildYahooSymbolCandidates(ticker, countryCode, override);
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

    // Pass all candidates; proxy tries them in order and returns first with data
    const symbolsParam = yahooSymbols.map(encodeURIComponent).join(',');
    fetch(`/api/yahoo-chart?symbols=${symbolsParam}&range=${chartRange}&interval=1d`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
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
    <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto', minWidth: 0, background: '#F7F8FA' }}>

      {/* Back */}
      <button onClick={onBack} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 20,
        background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
        fontSize: 13, color: '#6B7280', fontFamily: "'DM Sans', sans-serif",
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12,
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
            <span style={{ fontSize: 13, fontFamily: "'DM Mono', monospace", color: '#6B7280' }}>{ticker}</span>
            <span style={{ color: '#D1D5DB' }}>·</span>
            <span style={{ fontSize: 13, color: '#9CA3AF' }}>{countryCode}</span>
          </div>
        </div>
      </div>

      {/* ── Section 1: Chart ──────────────────────────────────────────────── */}
      <div style={{
        background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12,
        padding: '20px 24px', marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111318', marginBottom: 2 }}>Stock Price</h2>
            <p style={{ fontSize: 12, color: '#9CA3AF' }}>
              {chartData.length > 0
                ? `${chartData.length} trading days · ▲▼ insider trades${earningsDates?.length ? ' · 📅 earnings dates' : ''}`
                : 'Historical price chart'}
            </p>
          </div>
          {/* Range toggles */}
          <div style={{ display: 'flex', gap: 4, background: '#F3F4F6', borderRadius: 7, padding: 3 }}>
            {RANGES.map(r => (
              <button key={r.key} onClick={() => setChartRange(r.key)} style={{
                padding: '5px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: chartRange === r.key ? 600 : 400,
                background: chartRange === r.key ? '#fff' : 'transparent',
                color: chartRange === r.key ? '#111318' : '#9CA3AF',
                boxShadow: chartRange === r.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                fontFamily: "'DM Sans', sans-serif", transition: 'all 0.15s',
              }}>{r.label}</button>
            ))}
          </div>
        </div>

        {priceLoading ? (
          <div style={{
            height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#F9FAFB', borderRadius: 10, border: '1px solid #E8E9EE',
          }}>
            <div style={{ fontSize: 13, color: '#9CA3AF' }}>Loading chart…</div>
          </div>
        ) : (
          <StockChart
            data={chartData}
            trades={companyTrades}
            earningsDates={earningsDates || []}
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
      <div style={{ background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #F3F4F6' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#111318', marginBottom: 2 }}>
            All Insider Transactions
          </h2>
          <p style={{ fontSize: 12, color: '#9CA3AF' }}>
            {earningsDates?.length
              ? `Price analysis · real blackout detection (${earningsDates.length} known earnings dates) · conviction scoring`
              : 'Price analysis · conviction scoring'}
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
                <tr style={{ borderBottom: '1px solid #F3F4F6' }}>
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
                {companyTrades.map((t, i) => {
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
                      style={{ borderBottom: i < companyTrades.length - 1 ? '1px solid #F9FAFB' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#FAFBFF'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      {/* Date */}
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6B7280', fontFamily: "'DM Mono', monospace", whiteSpace: 'nowrap' }}>
                        {fmtDateShort(t.transaction_date)}
                      </td>

                      {/* Insider */}
                      <td style={{ padding: '10px 14px', maxWidth: 160, overflow: 'hidden' }}>
                        {name ? (
                          onInsiderClick ? (
                            <button onClick={() => onInsiderClick(name)} style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontWeight: 500, fontSize: 13, color: ACCENT, textAlign: 'left',
                              fontFamily: "'DM Sans', sans-serif",
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
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontWeight: 600, fontSize: 12, borderRadius: 4, padding: '2px 8px',
                          color:      isBuy ? '#15803D' : '#B91C1C',
                          background: isBuy ? '#F0FDF4' : '#FEF2F2',
                        }}>
                          <svg width="7" height="7" viewBox="0 0 8 8" fill={isBuy ? '#15803D' : '#B91C1C'}>
                            {isBuy
                              ? <polygon points="4,1 7,6 1,6"/>
                              : <polygon points="1,2 7,2 4,7"/>}
                          </svg>
                          {t.transaction_type}
                        </span>
                      </td>

                      {/* Shares */}
                      <td style={{ padding: '10px 14px', fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtShares(t.shares)}
                      </td>

                      {/* Price */}
                      <td style={{ padding: '10px 14px', fontSize: 12, fontFamily: "'DM Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {fmtPrice(t.price_per_share, t.currency)}
                      </td>

                      {/* Value */}
                      <td style={{ padding: '10px 14px', fontSize: 13, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {t.conviction_label && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                              background: t.conviction_label === 'High Conviction' ? '#FEF9C3' : '#EEF2FF',
                              color:      t.conviction_label === 'High Conviction' ? '#92400E' : ACCENT,
                            }}>
                              {t.conviction_label === 'High Conviction' ? '⭐ HIGH' : 'MED'}
                            </span>
                          )}
                          {/* Real pre-earnings badge — only shown when earnings data exists */}
                          {isBuy && blackout.isNear && (
                            <span
                              title={`Purchased ${blackout.daysBefore} day${blackout.daysBefore === 1 ? '' : 's'} before earnings (${fmtDateShort(blackout.earningsDate)}) — historically a strong buy signal`}
                              style={{
                                fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                                background: '#FEF3C7', color: '#92400E', cursor: 'help',
                              }}
                            >
                              📅 {blackout.daysBefore}d pre-earnings
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          📅 <strong>{preEarningsBuys.length} insider buy{preEarningsBuys.length > 1 ? 's' : ''} occurred 30–60 days before a real earnings date</strong> — just before the typical pre-earnings blackout begins.
          Research (Seyhun 1998, Lakonishok &amp; Lee 2001) shows CEO/CFO purchases in this window carry
          2–3× stronger predictive power than purchases at other times.
        </div>
      )}

    </main>
  );
}
