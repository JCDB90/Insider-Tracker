import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabase.js';

// Lazy-loaded — lightweight-charts (~175KB) only downloads when first opened
const CompanyPage = lazy(() => import('./CompanyPage.jsx'));

// ─── Analytics helpers ────────────────────────────────────────────────────────
function track(eventName, params) {
  try { window.gtag?.('event', eventName, params); } catch {}
}

// ─── Dynamic meta tags ───────────────────────────────────────────────────────
function useMetaTags(page, selectedCompany, selectedInsider) {
  useEffect(() => {
    let title = 'InsidersAlpha — European Insider Trading Tracker';
    let desc  = 'Track MAR Article 19 insider transactions across 13 European markets. Conviction scoring, cluster signals, and performance data.';

    if (page === 'company' && selectedCompany?.company) {
      title = `${selectedCompany.company} Insider Transactions | InsidersAlpha`;
      desc  = `Insider trading activity for ${selectedCompany.company}. Conviction scores, signal badges, and post-trade performance.`;
    } else if (page === 'insiders' && selectedInsider) {
      title = `${selectedInsider} Insider Trading History | InsidersAlpha`;
      desc  = `Insider trading track record for ${selectedInsider}. Historical buys, win rate, and average returns.`;
    } else if (page === 'pricing') {
      title = 'Pricing — InsidersAlpha';
      desc  = 'InsidersAlpha plans: Free, Pro (€9.99/mo), Elite (€19.99/mo). Unlock full European insider trading data.';
    } else if (page === 'insights') {
      title = 'Insights & Tools — InsidersAlpha';
      desc  = 'Tax calculators, broker guides, and education for European investors. Danish ETF lagerbeskatning, Swedish ISK, and more.';
    } else if (page === 'watchlist') {
      title = 'My Watchlist — InsidersAlpha';
    } else if (page === 'insiders') {
      title = 'Top Insiders Leaderboard — InsidersAlpha';
      desc  = 'Ranked list of European insiders by conviction score and historical performance.';
    }

    document.title = title;
    const setMeta = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
    setMeta('meta[name="description"]',       'content', desc);
    setMeta('meta[property="og:title"]',      'content', title);
    setMeta('meta[property="og:description"]','content', desc);
    setMeta('meta[name="twitter:title"]',     'content', title);
    setMeta('meta[name="twitter:description"]','content', desc);
  }, [page, selectedCompany, selectedInsider]);
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid #f0f0f0', padding: '14px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexWrap: 'wrap', gap: '4px 4px',
      fontSize: 11, color: '#9CA3AF', background: '#fff', flexShrink: 0,
    }}>
      <span>© 2026 InsidersAlpha</span>
      {[
        { label: 'About',       href: '/about' },
        { label: 'Methodology', href: '/methodology' },
        { label: 'Disclaimer',  href: '/disclaimer' },
        { label: 'Privacy',     href: '/privacy' },
        { label: 'Terms',       href: '/terms' },
        { label: 'Contact',     href: '/contact' },
      ].map(l => (
        <span key={l.href}>
          <span style={{ margin: '0 4px', color: '#e0e0e0' }}>·</span>
          <a href={l.href} style={{ color: '#9CA3AF', textDecoration: 'none', fontFamily: "'Inter', sans-serif" }}
            onMouseEnter={e => e.target.style.color = '#374151'}
            onMouseLeave={e => e.target.style.color = '#9CA3AF'}
          >{l.label}</a>
        </span>
      ))}
    </footer>
  );
}

// ─── Access control ───────────────────────────────────────────────────────────

function useAccess(plan) {
  const isAdmin = plan === 'admin';
  const isPro   = ['pro', 'elite', 'admin'].includes(plan);
  const isElite  = ['elite', 'admin'].includes(plan);
  return {
    isAdmin, isPro, isElite,
    dashboardPageLimit:  isPro ? null : 1,   // null = no limit
    companyHistoryLimit: isPro ? null : 3,
    insidersLimit:       isPro ? null : 5,
    canEditWatchlist:    isPro,
    canSeeAlerts:        isPro,
    canExport:           isElite,
  };
}

// ─── LoginModal ───────────────────────────────────────────────────────────────

function LoginModal({ onClose }) {
  const [mode, setMode]       = useState('signin');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [done, setDone]       = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    if (mode === 'signin') {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password });
      if (err) setError(err.message);
      else onClose();
    } else {
      const { error: err } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: 'https://www.insidersalpha.com' },
      });
      if (err) setError(err.message);
      else setDone('Check your email to confirm your account, then sign in.');
    }
    setLoading(false);
  }

  async function handleGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://www.insidersalpha.com' },
    });
  }

  const inputStyle = {
    width: '100%', padding: '9px 12px', border: '1px solid #f0f0f0', borderRadius: 7,
    fontSize: 13, fontFamily: "'Inter', sans-serif", outline: 'none', boxSizing: 'border-box',
    background: '#fafafa',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 14, padding: '32px 32px 28px',
        width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.18)', position: 'relative',
      }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, right: 16,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 20, color: '#9CA3AF', lineHeight: 1, padding: 2,
        }}>×</button>

        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111318', margin: '0 0 22px' }}>
          {mode === 'signin' ? 'Sign in to InsidersAlpha' : 'Create your account'}
        </h2>

        {done ? (
          <div style={{ textAlign: 'center', padding: '12px 0 20px' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>✉️</div>
            <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.7 }}>{done}</p>
          </div>
        ) : (
          <>
            <button onClick={handleGoogle} style={{
              width: '100%', padding: '10px 14px', border: '1px solid #f0f0f0', borderRadius: 8,
              background: '#fff', cursor: 'pointer', fontFamily: "'Inter', sans-serif",
              fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ flex: 1, height: 1, background: '#f0f0f0' }} /><span style={{ fontSize: 11, color: '#9CA3AF' }}>or</span><div style={{ flex: 1, height: 1, background: '#f0f0f0' }} />
            </div>

            <form onSubmit={handleSubmit}>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="Email" required style={{ ...inputStyle, marginBottom: 10 }} />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Password" required style={{ ...inputStyle, marginBottom: error ? 8 : 16 }} />
              {error && <div style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{error}</div>}
              <button type="submit" disabled={loading} style={{
                width: '100%', padding: '10px', background: ACCENT, color: '#fff', border: 'none',
                borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: loading ? 'default' : 'pointer',
                fontFamily: "'Inter', sans-serif", opacity: loading ? 0.7 : 1,
              }}>{loading ? 'Loading…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button onClick={() => { setMode(m => m === 'signin' ? 'signup' : 'signin'); setError(''); }} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: '#9CA3AF', fontFamily: "'Inter', sans-serif",
              }}>
                {mode === 'signin' ? "No account? Sign up free" : "Already have an account? Sign in"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Upgrade gate components ──────────────────────────────────────────────────

function UpgradeGate({ title = 'Unlock with Pro', sub, onUpgrade, compact }) {
  if (compact) return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, color: '#9CA3AF',
    }}>
      <span>🔒</span>
      <button onClick={onUpgrade} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: 11, color: ACCENT, fontWeight: 600, fontFamily: "'Inter', sans-serif", padding: 0,
      }}>Unlock with Pro →</button>
    </div>
  );
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 20px', gap: 8,
      background: 'linear-gradient(to bottom, rgba(255,255,255,0.4) 0%, #fff 35%)',
    }}>
      <span style={{ fontSize: 24 }}>🔒</span>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#111318', textAlign: 'center' }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>{sub}</div>}
      <button onClick={onUpgrade} style={{
        background: ACCENT, color: '#fff', border: 'none', borderRadius: 7,
        padding: '7px 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        fontFamily: "'Inter', sans-serif", marginTop: 4,
      }}>Unlock with Pro →</button>
    </div>
  );
}

function DashboardUpgradeBanner({ onLogin, onUpgrade }) {
  return (
    <div style={{
      position: 'sticky', bottom: 0,
      background: 'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.95) 30%, #fff 55%)',
      padding: '32px 20px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      borderTop: '1px solid #f0f0f0',
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318', marginBottom: 2 }}>
          🔒 Unlock full data access
        </div>
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          Pro from €19/month — unlimited transactions, all signals, full history
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button onClick={onLogin} style={{
          padding: '7px 14px', border: '1px solid #f0f0f0', borderRadius: 7,
          background: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer',
          fontFamily: "'Inter', sans-serif", color: '#374151',
        }}>Sign in</button>
        <button onClick={onUpgrade} style={{
          padding: '7px 14px', background: ACCENT, color: '#fff', border: 'none',
          borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          fontFamily: "'Inter', sans-serif",
        }}>Start free trial →</button>
      </div>
    </div>
  );
}

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

function TopBar({ page, setPage, search, setSearch, alertCount, session, isAdmin, isElite, onLogin, onSignOut }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const navItems = [
    { label: 'Dashboard',    key: 'dashboard' },
    { label: 'Watchlist',    key: 'watchlist', dot: alertCount > 0 },
    { label: 'Top Insiders', key: 'insiders'   },
    { label: 'Insights',     key: 'insights'   },
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginRight: 32, flexShrink: 0 }}>
        <svg width="28" height="28" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
          <rect width="36" height="36" rx="5" fill="#0f1117"/>
          <rect x="4" y="6" width="6" height="24" fill="white"/>
          <polygon points="17,6 20,6 24,30 21,30" fill="white"/>
          <polygon points="17,6 20,6 16,30 13,30" fill="white"/>
          <rect x="14" y="19" width="9" height="3" fill="white"/>
        </svg>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em', color: '#111318' }}>
          InsidersAlpha
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
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              {item.label}
              {item.dot ? (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: '#DC2626', flexShrink: 0, display: 'inline-block',
                }} />
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Auth */}
      {session ? (
        <div style={{ position: 'relative', marginLeft: 16, flexShrink: 0 }}>
          <button
            onClick={() => setShowUserMenu(s => !s)}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: isAdmin ? '#F59E0B' : ACCENT,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >{(session.user.email?.[0] || 'U').toUpperCase()}</button>

          {showUserMenu && (
            <div style={{
              position: 'absolute', top: 40, right: 0,
              background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.10)', minWidth: 180, zIndex: 300,
            }} onClick={() => setShowUserMenu(false)}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 2 }}>Signed in as</div>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: '#111318',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{session.user.email}</div>
                {isAdmin && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: '#F59E0B',
                    background: '#FFFBEB', border: '1px solid #FDE68A',
                    borderRadius: 3, padding: '1px 5px',
                    textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4, display: 'inline-block',
                  }}>Admin</span>
                )}
              </div>
              {!isElite && (
                <button onClick={() => setPage('pricing')} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 16px', background: 'none', border: 'none',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600, color: ACCENT,
                  fontFamily: "'Inter', sans-serif",
                }}>⬆ Upgrade plan</button>
              )}
              <button onClick={onSignOut} style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 16px', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 12, color: '#374151',
                fontFamily: "'Inter', sans-serif", borderTop: '1px solid #f0f0f0',
              }}>Sign out</button>
            </div>
          )}
        </div>
      ) : (
        <button onClick={onLogin} style={{
          marginLeft: 16, padding: '6px 16px', borderRadius: 7, flexShrink: 0,
          background: ACCENT, color: '#fff', border: 'none',
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
          fontFamily: "'Inter', sans-serif",
        }}>Sign in</button>
      )}
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

function TradesTable({ rows, loading, sortBy, sortDir, onSort, onInsiderClick, onCompanyClick, page, onPageChange, access, onLogin, onUpgrade }) {
  const locked = access && !access.isPro && page > 1;
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
                  {/* Type + signal badges — blurred on locked pages */}
                  <td style={{ padding: rowPad }}>
                    {locked ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <TypeChip type={row.transaction_type} />
                        <span style={{ fontSize: 12, color: '#D1D5DB' }}>🔒</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap' }}>
                        <TypeChip type={row.transaction_type} />
                        <SignalBadges t={row} />
                      </div>
                    )}
                  </td>
                  {/* Price */}
                  <td style={{ padding: rowPad, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#374151', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {locked
                      ? <span style={{ filter: 'blur(4px)', userSelect: 'none', color: '#9CA3AF' }}>€ ···</span>
                      : formatPrice(row.price_per_share, row.currency)}
                  </td>
                  {/* Value */}
                  <td style={{ padding: rowPad, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    {locked
                      ? <span style={{ filter: 'blur(4px)', userSelect: 'none', color: '#9CA3AF' }}>€ ···</span>
                      : formatValue(row.total_value, row.currency)}
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
      {locked && (
        <DashboardUpgradeBanner onLogin={onLogin} onUpgrade={onUpgrade} />
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

function WatchlistPage({ trades, tradesLoading, buybacks, watchlist, watchlistTickers, addToWatchlist, onInsiderClick, onCompanyClick, alertCount, initialTab, access, onUpgrade, onLogin }) {
  const [tab, setTab] = useState(initialTab || 'stocks');
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

      {/* Tab pills */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{
          display: 'flex', gap: 3,
          background: '#f8f8f8', border: '1px solid #f0f0f0',
          borderRadius: 8, padding: 3,
        }}>
          {[
            { key: 'stocks', label: 'My Stocks' },
            { key: 'alerts', label: 'Alerts', count: alertCount },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', borderRadius: 6, border: 'none',
              background: tab === t.key ? '#fff' : 'transparent',
              color: tab === t.key ? '#111318' : '#9CA3AF',
              fontWeight: tab === t.key ? 600 : 400,
              fontSize: 12, fontFamily: "'Inter', sans-serif", cursor: 'pointer',
              boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.12s',
            }}>
              {t.label}
              {t.count > 0 && (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: '#DC2626', display: 'inline-block', flexShrink: 0,
                }} />
              )}
            </button>
          ))}
        </div>
        {tab === 'stocks' && (
          access && !access.canEditWatchlist ? (
            <button onClick={onUpgrade} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', background: '#fff', color: ACCENT,
              border: '1px solid ' + ACCENT, borderRadius: 8, cursor: 'pointer',
              fontSize: 12, fontWeight: 600, fontFamily: "'Inter', sans-serif", flexShrink: 0,
            }}>🔒 Add own stocks — Pro →</button>
          ) : (
            <button
              onClick={() => setShowAddModal(true)}
              title="Add stock to watchlist"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', background: ACCENT, color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: "'Inter', sans-serif", flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              Add stock
            </button>
          )
        )}
      </div>

      {/* ── Alerts tab ── */}
      {tab === 'alerts' && (
        <AlertsPage
          trades={trades} tradesLoading={tradesLoading}
          watchlist={watchlist} watchlistTickers={watchlistTickers}
          onCompanyClick={onCompanyClick} onInsiderClick={onInsiderClick}
          access={access} onUpgrade={onUpgrade}
          embedded
        />
      )}

      {/* ── My Stocks tab ── */}
      {tab === 'stocks' && <>
      <div style={{ marginBottom: 28, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#111318', letterSpacing: '-0.01em', marginBottom: 4 }}>
            My Watchlist
          </h1>
          <p style={{ fontSize: 13, color: '#9CA3AF' }}>Insider activity in your personally tracked stocks</p>
        </div>
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
      </>}
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
  access, onLogin, onUpgrade,
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
              access={access}
              onLogin={onLogin}
              onUpgrade={onUpgrade}
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

function InsidersPage({ trades, performance, tradesLoading, perfLoading, onInsiderClick, onCompanyClick, access, onUpgrade }) {
  const leaderboard = useMemo(() =>
    tradesLoading ? [] : computeInsiderScorecard(trades, performance),
    [trades, performance, tradesLoading]
  );
  const FREE_LIMIT = 5;
  const visibleRows  = (access && !access.isPro) ? leaderboard.slice(0, FREE_LIMIT) : leaderboard;
  const lockedRows   = (access && !access.isPro) ? leaderboard.slice(FREE_LIMIT, FREE_LIMIT + 3) : [];

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
                  {visibleRows.map((ins, i) => {
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

                  {/* Blurred preview rows for locked insiders */}
                  {lockedRows.map((ins, i) => (
                    <tr key={'locked-' + i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      {[...Array(8)].map((_, j) => (
                        <td key={j} style={{ padding: '12px 14px' }}>
                          <div style={{
                            height: 14, borderRadius: 4,
                            background: '#f0f0f0', filter: 'blur(4px)',
                            width: [24, 120, 90, 40, 50, 50, 60, 60][j] || 60,
                          }} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lockedRows.length > 0 && (
              <UpgradeGate
                title={`Unlock ${leaderboard.length - FREE_LIMIT} more insiders`}
                sub="Full leaderboard with complete track records"
                onUpgrade={onUpgrade}
              />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ─── AlertsPage ───────────────────────────────────────────────────────────────

const ALERT_TYPES = [
  { key: 'all',            label: 'All' },
  { key: 'watchlist',      label: '⭐ Watchlist' },
  { key: 'conviction',     label: '🔥 High Conviction' },
  { key: 'cluster',        label: '🔄 Cluster' },
  { key: 'large',          label: '💰 Large' },
];

function AlertsPage({ trades, tradesLoading, watchlist, watchlistTickers, onCompanyClick, onInsiderClick, embedded, access, onUpgrade }) {
  watchlistTickers = watchlistTickers || new Set();
  const [activeFilter, setActiveFilter] = useState('all');

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days}d ago`;
  }

  const isBuy = t => { const tp = (t.transaction_type || '').toUpperCase(); return tp === 'BUY' || tp === 'PURCHASE'; };

  const cutoff7d  = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 7);  return d.toISOString().slice(0, 10); }, []);
  const cutoff30d = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }, []);

  // High Conviction Buys — last 7 days
  const convictionAlerts = useMemo(() =>
    trades
      .filter(t => isBuy(t) && t.conviction_label === 'High Conviction' && t.transaction_date >= cutoff7d)
      .sort((a, b) => Number(b.total_value || 0) - Number(a.total_value || 0)),
    [trades, cutoff7d],
  );

  // Watchlist Alerts — last 30 days (any direction)
  const watchlistAlerts = useMemo(() =>
    trades
      .filter(t => watchlistTickers.has(t.ticker) && t.transaction_date >= cutoff30d)
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date)),
    [trades, watchlistTickers, cutoff30d],
  );

  // Cluster Signals — last 7 days, group by company, show where 2+ insiders bought
  const clusterGroups = useMemo(() => {
    const raw = trades.filter(t => t.is_cluster_buy && t.transaction_date >= cutoff7d);
    const map = {};
    for (const t of raw) {
      const key = t.company || t.ticker || '';
      if (!map[key]) map[key] = { company: t.company, ticker: t.ticker, country_code: t.country_code, trades: [] };
      map[key].trades.push(t);
    }
    return Object.values(map)
      .filter(g => g.trades.length >= 2)
      .sort((a, b) => {
        const av = a.trades.reduce((s, t) => s + Number(t.total_value || 0), 0);
        const bv = b.trades.reduce((s, t) => s + Number(t.total_value || 0), 0);
        return bv - av;
      });
  }, [trades, cutoff7d]);

  // Large Purchases — BUY >= €500K, last 7 days
  const largeAlerts = useMemo(() =>
    trades
      .filter(t => isBuy(t) && Number(t.total_value || 0) >= 500000 && t.transaction_date >= cutoff7d)
      .sort((a, b) => Number(b.total_value || 0) - Number(a.total_value || 0)),
    [trades, cutoff7d],
  );

  // Total unique alert count for nav badge (deduped by id)
  const alertIds = useMemo(() => {
    const ids = new Set();
    convictionAlerts.forEach(t => ids.add(t.id));
    watchlistAlerts.forEach(t => ids.add(t.id));
    clusterGroups.forEach(g => g.trades.forEach(t => ids.add(t.id)));
    largeAlerts.forEach(t => ids.add(t.id));
    return ids;
  }, [convictionAlerts, watchlistAlerts, clusterGroups, largeAlerts]);

  // ── Card renderers ────────────────────────────────────────────────────────

  function ChevronRight() {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
        <polyline points="9 18 15 12 9 6" />
      </svg>
    );
  }

  function AlertCard({ icon, accentColor, borderColor, bgColor, tag, children, onClick }) {
    const [hov, setHov] = useState(false);
    return (
      <div
        onClick={onClick}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          background: hov ? '#fafafa' : '#fff',
          border: '1px solid ' + (hov ? '#e0e0e0' : borderColor),
          borderLeft: '3px solid ' + accentColor,
          borderRadius: 8, padding: '12px 16px',
          display: 'flex', alignItems: 'flex-start', gap: 12,
          cursor: onClick ? 'pointer' : 'default',
          transition: 'all 0.12s',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
              background: bgColor, color: accentColor, borderRadius: 3, padding: '1px 6px',
            }}>{tag}</span>
          </div>
          {children}
        </div>
        {onClick && <ChevronRight />}
      </div>
    );
  }

  function TradeAlertCard({ t, icon, accentColor, borderColor, bgColor, tag }) {
    const name = (t.insider_name && t.insider_name !== 'Not disclosed') ? t.insider_name : (t.via_entity || null);
    const dir  = isBuy(t) ? 'bought' : 'sold';
    return (
      <AlertCard
        icon={icon} accentColor={accentColor} borderColor={borderColor} bgColor={bgColor} tag={tag}
        onClick={() => onCompanyClick && onCompanyClick(t.ticker, t.company, t.country_code)}
      >
        <div style={{ fontSize: 13, color: '#111318', marginBottom: 2 }}>
          <span
            style={{ fontWeight: 600, cursor: onCompanyClick ? 'pointer' : 'default', color: '#111318' }}
          >{t.company}</span>
          {t.country_code && <><span style={{ color: '#9CA3AF', margin: '0 4px' }}>·</span><Flag code={t.country_code} /></>}
          {t.insider_role && <><span style={{ color: '#9CA3AF', margin: '0 4px' }}>·</span><span style={{ color: '#6B7280', fontSize: 12 }}>{t.insider_role}</span></>}
        </div>
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          {name ? (
            <span
              onClick={e => { e.stopPropagation(); onInsiderClick && onInsiderClick(name); }}
              style={{ fontWeight: 500, color: '#374151', cursor: onInsiderClick ? 'pointer' : 'default' }}
            >{name}</span>
          ) : <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>Insider</span>}
          {' '}{dir}{' '}
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318' }}>
            {formatValue(t.total_value, t.currency)}
          </span>
          {t.price_per_share > 0 && (
            <> @ <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{formatPrice(t.price_per_share, t.currency)}</span></>
          )}
          <span style={{ color: '#9CA3AF', marginLeft: 8 }}>{timeAgo(t.transaction_date)}</span>
        </div>
        {(t.is_cluster_buy || t.is_pre_earnings || t.is_repetitive_buy || t.is_price_dip) && (
          <div style={{ marginTop: 4 }}><SignalBadges t={t} /></div>
        )}
      </AlertCard>
    );
  }

  // ── Section renderer ──────────────────────────────────────────────────────

  function Section({ title, count, children, emptyMsg }) {
    if (count === 0) return null;
    return (
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: '#111318', margin: 0 }}>{title}</h2>
          <span style={{ fontSize: 11, color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace" }}>{count}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children}
        </div>
      </div>
    );
  }

  // ── Filter logic ──────────────────────────────────────────────────────────

  const showConviction = activeFilter === 'all' || activeFilter === 'conviction';
  const showWatchlist  = activeFilter === 'all' || activeFilter === 'watchlist';
  const showCluster    = activeFilter === 'all' || activeFilter === 'cluster';
  const showLarge      = activeFilter === 'all' || activeFilter === 'large';

  const isEmpty = !tradesLoading && (
    (showConviction && convictionAlerts.length === 0) &&
    (showWatchlist  && watchlistAlerts.length === 0) &&
    (showCluster    && clusterGroups.length === 0) &&
    (showLarge      && largeAlerts.length === 0)
  );

  // Visitor teaser — show counts but not content
  if (access && !access.canSeeAlerts) {
    const totalCount = alertIds.size;
    const teaser = (
      <div style={{ padding: embedded ? '16px 0' : '32px', maxWidth: 760, margin: '0 auto' }}>
        {!embedded && (
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>Alerts</h1>
        )}
        <div style={{
          background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
          overflow: 'hidden',
        }}>
          {[
            { icon: '🔥', label: `${convictionAlerts.length} High Conviction buys` },
            { icon: '🔄', label: `${clusterGroups.length} Cluster signals` },
            { icon: '💰', label: `${largeAlerts.length} Large purchases (≥€500K)` },
            { icon: '⭐', label: `${watchlistAlerts.length} Watchlist transactions` },
          ].map((item, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px', borderBottom: '1px solid #f0f0f0',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>{item.icon}</span>
                <span style={{ fontSize: 13, color: '#374151', filter: 'blur(0)', fontWeight: 500 }}>
                  <span style={{ filter: 'blur(3px)', userSelect: 'none', marginRight: 4 }}>{item.label.split(' ')[0]}</span>
                  {item.label.split(' ').slice(1).join(' ')}
                </span>
              </div>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>🔒</span>
            </div>
          ))}
          <UpgradeGate
            title={`Unlock ${totalCount} alerts`}
            sub="High conviction buys, cluster signals, large purchases — Pro from €19/month"
            onUpgrade={onUpgrade}
          />
        </div>
      </div>
    );
    return embedded ? teaser : <main style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>{teaser}</main>;
  }

  const inner = (
    <div style={{ maxWidth: embedded ? '100%' : 760, margin: embedded ? 0 : '0 auto', padding: embedded ? 0 : '28px 32px' }}>

        {/* Header — only show when standalone */}
        {!embedded && (
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>Alerts</h1>
          <p style={{ fontSize: 13, color: '#6B7280' }}>
            Signal-driven insider activity — high conviction buys, cluster signals, watchlist moves.
          </p>
        </div>
        )}

        {/* Filter tabs */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 20,
          background: '#f8f8f8', border: '1px solid #f0f0f0',
          borderRadius: 8, padding: 3, width: 'fit-content',
        }}>
          {ALERT_TYPES.map(at => (
            <button
              key={at.key}
              onClick={() => setActiveFilter(at.key)}
              style={{
                padding: '5px 12px', borderRadius: 6, border: 'none',
                background: activeFilter === at.key ? '#fff' : 'transparent',
                color: activeFilter === at.key ? '#111318' : '#9CA3AF',
                fontWeight: activeFilter === at.key ? 600 : 400,
                fontSize: 12, fontFamily: "'Inter', sans-serif",
                cursor: 'pointer',
                boxShadow: activeFilter === at.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.12s', whiteSpace: 'nowrap',
              }}
            >{at.label}</button>
          ))}
        </div>

        {tradesLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} style={{ height: 72, borderRadius: 8, background: '#f0f0f0', animation: 'pulse 1.5s infinite' }} />
            ))}
          </div>
        ) : isEmpty ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔔</div>
            <div style={{ fontSize: 14, color: '#6B7280', fontWeight: 500 }}>No alerts for this filter</div>
            <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
              Try a different category or check back tomorrow.
            </div>
          </div>
        ) : (
          <>
            {/* ── Watchlist ── */}
            {showWatchlist && watchlistAlerts.length > 0 && (
              <Section title="Watchlist Activity" count={watchlistAlerts.length}>
                {watchlistAlerts.map(t => (
                  <TradeAlertCard key={t.id} t={t}
                    icon="⭐" tag="Watchlist"
                    accentColor="#D97706" borderColor="#FDE68A" bgColor="#FFFBEB"
                  />
                ))}
              </Section>
            )}

            {/* ── High Conviction ── */}
            {showConviction && convictionAlerts.length > 0 && (
              <Section title="High Conviction Buys" count={convictionAlerts.length}>
                {convictionAlerts.map(t => (
                  <TradeAlertCard key={t.id} t={t}
                    icon="🔥" tag="High Conviction"
                    accentColor="#EA580C" borderColor="#FED7AA" bgColor="#FFF7ED"
                  />
                ))}
              </Section>
            )}

            {/* ── Cluster ── */}
            {showCluster && clusterGroups.length > 0 && (
              <Section title="Cluster Signals" count={clusterGroups.length}>
                {clusterGroups.map((g, i) => {
                  const totalVal = g.trades.reduce((s, t) => s + Number(t.total_value || 0), 0);
                  const insiders = [...new Set(g.trades.map(t => t.insider_name).filter(Boolean))];
                  const currency = g.trades[0]?.currency || 'EUR';
                  return (
                    <AlertCard key={i}
                      icon="🔄" tag="Cluster Signal"
                      accentColor="#4338CA" borderColor="#C7D2FE" bgColor="#EEF2FF"
                      onClick={() => onCompanyClick && onCompanyClick(g.ticker, g.company, g.country_code)}
                    >
                      <div style={{ fontSize: 13, color: '#111318', fontWeight: 600, marginBottom: 2 }}>
                        {g.company}
                        {g.country_code && <><span style={{ color: '#9CA3AF', margin: '0 4px' }}>·</span><Flag code={g.country_code} /></>}
                      </div>
                      <div style={{ fontSize: 12, color: '#6B7280' }}>
                        <span style={{ fontWeight: 500, color: '#374151' }}>{g.trades.length} insiders</span>
                        {' '}bought within 7 days
                        {totalVal > 0 && <> · Total <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318' }}>{formatValue(totalVal, currency)}</span></>}
                      </div>
                      {insiders.length > 0 && (
                        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                          {insiders.slice(0, 3).join(', ')}{insiders.length > 3 ? ` +${insiders.length - 3} more` : ''}
                        </div>
                      )}
                    </AlertCard>
                  );
                })}
              </Section>
            )}

            {/* ── Large Transactions ── */}
            {showLarge && largeAlerts.length > 0 && (
              <Section title="Large Purchases (≥€500K)" count={largeAlerts.length}>
                {largeAlerts.map(t => (
                  <TradeAlertCard key={t.id} t={t}
                    icon="💰" tag="Large Purchase"
                    accentColor="#15803D" borderColor="#A7F3D0" bgColor="#F0FDF4"
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </div>
  );
  return embedded ? inner : <main style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>{inner}</main>;
}

// Compute alert count for nav badge (exported via prop from App)
function useAlertCount(trades, watchlistTickers) {
  return useMemo(() => {
    if (!trades.length) return 0;
    const cutoff7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const isBuy = t => { const tp = (t.transaction_type || '').toUpperCase(); return tp === 'BUY' || tp === 'PURCHASE'; };
    const ids = new Set();
    for (const t of trades) {
      const d = t.transaction_date;
      if (isBuy(t) && t.conviction_label === 'High Conviction' && d >= cutoff7d) ids.add(t.id);
      if (watchlistTickers.has(t.ticker) && d >= cutoff30d) ids.add(t.id);
      if (t.is_cluster_buy && d >= cutoff7d) ids.add(t.id);
      if (isBuy(t) && Number(t.total_value || 0) >= 500000 && d >= cutoff7d) ids.add(t.id);
    }
    return ids.size;
  }, [trades, watchlistTickers]);
}

// ─── InsightsPage ─────────────────────────────────────────────────────────────

const EDUCATION_ITEMS = [
  {
    title: 'What Is Insider Trading? (The Legal Kind)',
    body: 'MAR Article 19 requires company executives, directors, and closely associated persons to disclose their personal trades within 3 business days. This is the legal, regulated form of insider reporting — distinct from illegal insider trading.',
    tag: 'Basics',
  },
  {
    title: 'How to Read Conviction Signals',
    body: 'High Conviction scores combine four factors: purchase size relative to the insider\'s history, role seniority (CEO/CFO outweigh board members), clustering with peers, and proximity to pre-earnings blackout windows.',
    tag: 'Signals',
  },
  {
    title: 'Understanding Cluster Buying',
    body: 'A cluster signal fires when 2 or more insiders at the same company buy within a 14-day window. Academic research shows cluster buys outperform single-insider buys by ~4% on a 90-day horizon.',
    tag: 'Signals',
  },
  {
    title: 'Pre-Earnings Blackout Periods',
    body: 'Most European companies impose a self-imposed trading blackout in the 30 days before earnings. Insiders buying 30–60 days before a likely earnings date are acting just before the window closes — a meaningful timing signal.',
    tag: 'Context',
  },
  {
    title: 'Why Sells Are Harder to Interpret',
    body: 'Insider sells happen for many reasons unrelated to outlook: diversification, tax planning, liquidity needs. Academic literature shows buys carry roughly 3× more information content than sells.',
    tag: 'Context',
  },
  {
    title: 'MAR Article 19 Across Markets',
    body: 'Each EU country\'s regulator publishes filings separately: AFM (Netherlands), AMF (France), BaFin (Germany), CNMV (Spain), FSMA (Belgium), Finanstilsynet (Denmark/Norway). We aggregate all of them daily.',
    tag: 'Data',
  },
];

const BROKER_GUIDES = [
  {
    title: 'Best Brokers for European Stocks 2026',
    desc: 'Compare Interactive Brokers, DEGIRO, Saxo, and eToro on fees, market access, and execution quality for EU-listed equities.',
    tag: 'Brokers',
  },
  {
    title: 'How to Buy French Stocks as a Non-Resident',
    desc: 'Euronext Paris, PEA accounts, withholding tax treaties, and which brokers give direct SRD access — a practical walkthrough.',
    tag: 'France',
  },
  {
    title: 'Low-Cost Brokers for Nordic Markets',
    desc: 'Nasdaq Helsinki, Stockholm, Copenhagen, and Oslo coverage varies widely by broker. We benchmark fees and access for each exchange.',
    tag: 'Nordics',
  },
  {
    title: 'German Stock Investing for Non-EU Residents',
    desc: 'XETRA access, Kapitalertragsteuer withholding, broker requirements, and the cheapest routes to Dax and SDAX exposure.',
    tag: 'Germany',
  },
];

// ── Shared SVG line chart (no external deps) ─────────────────────────────────

function TaxLineChart({ series, years, fmtY }) {
  const W = 560, H = 230;
  const pad = { t: 12, r: 16, b: 28, l: 62 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

  const allVals = series.flatMap(s => s.data).filter(v => v != null && isFinite(v));
  if (!allVals.length) return null;
  const maxV = Math.max(...allVals);
  const minV = 0;
  const range = maxV - minV || 1;

  const xs = i => pad.l + (i / years) * cw;
  const ys = v => pad.t + ch - ((v - minV) / range) * ch;

  const niceMax = Math.ceil(maxV / Math.pow(10, Math.floor(Math.log10(maxV)))) * Math.pow(10, Math.floor(Math.log10(maxV)));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => minV + f * maxV);

  const xTickStep = years <= 15 ? 5 : years <= 25 ? 5 : 10;
  const xTicks = [];
  for (let y = 0; y <= years; y += xTickStep) xTicks.push(y);
  if (xTicks[xTicks.length - 1] !== years) xTicks.push(years);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={ys(v)} y2={ys(v)}
            stroke={i === 0 ? '#e0e0e0' : '#f0f0f0'} strokeWidth="1" />
          <text x={pad.l - 5} y={ys(v) + 3.5} textAnchor="end"
            fontSize="9" fill="#9CA3AF" fontFamily="JetBrains Mono, monospace">
            {fmtY(v)}
          </text>
        </g>
      ))}
      {xTicks.map(y => (
        <text key={y} x={xs(y)} y={H - 6} textAnchor="middle"
          fontSize="9" fill="#9CA3AF" fontFamily="JetBrains Mono, monospace">
          {y === 0 ? 'Now' : `${y}y`}
        </text>
      ))}
      {series.map(s => {
        const pts = s.data
          .map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`)
          .join(' ');
        return (
          <polyline key={s.key} points={pts} fill="none"
            stroke={s.color} strokeWidth={s.bold ? 2.2 : 1.5}
            strokeLinejoin="round" strokeLinecap="round"
            strokeDasharray={s.dashed ? '5 3' : undefined}
          />
        );
      })}
    </svg>
  );
}

function ChartLegend({ series }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
      {series.map(s => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="2" style={{ overflow: 'visible' }}>
            <line x1="0" y1="1" x2="20" y2="1" stroke={s.color} strokeWidth="2"
              strokeDasharray={s.dashed ? '4 2' : undefined} />
          </svg>
          <span style={{ fontSize: 11, color: '#6B7280' }}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Danish compound interest calculator ──────────────────────────────────────

function DKCalculator() {
  const [initial,  setInitial]  = useState(100000);
  const [monthly,  setMonthly]  = useState(3000);
  const [ret,      setRet]      = useState(7);
  const [years,    setYears]    = useState(20);
  const [lagerRate,setLagerRate]= useState(17);  // % annual on unrealized gain
  const [exitRate, setExitRate] = useState(42);  // % at exit (realised)

  const fmtDKK = v => {
    if (v >= 1e6) return 'DKK ' + (v / 1e6).toFixed(2) + 'm';
    if (v >= 1e3) return 'DKK ' + (v / 1e3).toFixed(0) + 'k';
    return 'DKK ' + Math.round(v).toLocaleString();
  };

  const results = useMemo(() => {
    const mr = Math.pow(1 + ret / 100, 1 / 12) - 1;

    // Helper: grow one year with monthly contributions
    function growYear(start) {
      let p = start;
      for (let m = 0; m < 12; m++) p = p * (1 + mr) + monthly;
      return p;
    }

    const noTax = [initial];
    const lager = [initial];       // ETF on positivliste — lagerbeskatning
    const realised = [initial];    // ETF off positivliste — 42% at exit
    const indiv = [initial];       // Individual stocks — progressive at exit

    let pNoTax = initial, pLager = initial, pReal = initial, pIndiv = initial;
    let totalInvested = initial;
    let totalLagerTax = 0;
    const tableRows = [];

    for (let y = 1; y <= years; y++) {
      totalInvested += monthly * 12;

      // No tax
      pNoTax = growYear(pNoTax);

      // Lagerbeskatning: pay lagerRate% of unrealised gain each year
      const lagerStart = pLager;
      pLager = growYear(pLager);
      const yearGain = pLager - lagerStart - monthly * 12;
      if (yearGain > 0) {
        const tax = yearGain * (lagerRate / 100);
        pLager -= tax;
        totalLagerTax += tax;
      }

      // Realised (exitRate% on total gain at exit)
      pReal = growYear(pReal);
      const gainReal = pReal - totalInvested;
      const taxReal = gainReal > 0 ? gainReal * (exitRate / 100) : 0;

      // Individual stocks (27% on first 61k DKK, exitRate% above)
      pIndiv = growYear(pIndiv);
      const gainIndiv = pIndiv - totalInvested;
      let taxIndiv = 0;
      if (gainIndiv > 0) {
        const bracket = 61000;
        taxIndiv = gainIndiv <= bracket
          ? gainIndiv * 0.27
          : bracket * 0.27 + (gainIndiv - bracket) * (exitRate / 100);
      }

      noTax.push(pNoTax);
      lager.push(pLager);
      realised.push(pReal - taxReal);
      indiv.push(pIndiv - taxIndiv);

      if (y % 5 === 0 || y === years) {
        tableRows.push({
          year: y,
          noTax: pNoTax,
          lagerVal: pLager,
          lagerTax: totalLagerTax,
          realisedNet: pReal - taxReal,
          taxReal,
          indivNet: pIndiv - taxIndiv,
        });
      }
    }

    return { noTax, lager, realised, indiv, tableRows };
  }, [initial, monthly, ret, years, lagerRate, exitRate]);

  const series = [
    { key: 'notax',    label: 'No tax (theoretical)',              color: '#9CA3AF', data: results.noTax,    dashed: true  },
    { key: 'lager',    label: `ETF Positivliste (${lagerRate}% annual)`, color: '#0f1117', data: results.lager,    bold: true    },
    { key: 'real',     label: `ETF off-list (${exitRate}% at exit)`,     color: '#EA580C', data: results.realised },
    { key: 'indiv',    label: 'Individual stocks (27/42% at exit)', color: '#4338CA', data: results.indiv    },
  ];

  const InputRow = ({ label, children }) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6B7280',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );

  const numStyle = {
    width: '100%', padding: '7px 10px', border: '1px solid #f0f0f0', borderRadius: 6,
    fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: '#111318',
    background: '#fafafa', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🇩🇰</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>
              Danish ETF Tax Calculator — Lagerbeskatning vs Realisationsbeskatning
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
              ETFs on the <a href="https://www.skat.dk" target="_blank" rel="noopener" style={{ color: '#4338CA' }}>SKAT investeringsoversigt</a> (formerly positivliste) are taxed annually on unrealised gains.
              ETFs outside it pay tax only when sold. This calculator shows the compound effect.
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '20px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24, alignItems: 'start' }}>
        {/* Inputs */}
        <div>
          <InputRow label="Initial investment (DKK)">
            <input type="number" value={initial} min="0" step="10000"
              onChange={e => setInitial(Number(e.target.value))} style={numStyle} />
          </InputRow>
          <InputRow label="Monthly contribution (DKK)">
            <input type="number" value={monthly} min="0" step="500"
              onChange={e => setMonthly(Number(e.target.value))} style={numStyle} />
          </InputRow>
          <InputRow label={`Annual return: ${ret}%`}>
            <input type="range" value={ret} min="1" max="15" step="0.5"
              onChange={e => setRet(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#0f1117' }} />
          </InputRow>
          <InputRow label={`Investment horizon: ${years} years`}>
            <input type="range" value={years} min="1" max="40" step="1"
              onChange={e => setYears(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#0f1117' }} />
          </InputRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <InputRow label={`Lager rate: ${lagerRate}%`}>
              <input type="number" value={lagerRate} min="1" max="50" step="1"
                onChange={e => setLagerRate(Number(e.target.value))} style={numStyle} />
            </InputRow>
            <InputRow label={`Exit rate: ${exitRate}%`}>
              <input type="number" value={exitRate} min="1" max="60" step="1"
                onChange={e => setExitRate(Number(e.target.value))} style={numStyle} />
            </InputRow>
          </div>
          <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.5, marginTop: 4 }}>
            Adjust lager rate (currently 17% aktieindkomst / 42% kapitalindkomst depending on your bracket).
            Individual stocks use 27% on first DKK 61,000 gain, then exit rate above.
          </div>
        </div>

        {/* Chart */}
        <div>
          <TaxLineChart series={series} years={years} fmtY={fmtDKK} />
          <ChartLegend series={series} />
        </div>
      </div>

      {/* Table */}
      <div style={{ borderTop: '1px solid #f0f0f0', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
              {['Year','No-tax value','ETF Positivliste','Tax paid (lager)','ETF Off-list (net)','Individual stocks (net)'].map(h => (
                <th key={h} style={{ padding: '8px 14px', textAlign: 'right', fontSize: 10, fontWeight: 700,
                  color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em',
                  whiteSpace: 'nowrap', '&:first-child': { textAlign: 'left' } }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.tableRows.map((r, i) => (
              <tr key={r.year} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '8px 14px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318' }}>{r.year}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#9CA3AF' }}>{fmtDKK(r.noTax)}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318' }}>{fmtDKK(r.lagerVal)}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#DC2626' }}>−{fmtDKK(r.lagerTax)}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#374151' }}>{fmtDKK(r.realisedNet)}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#4338CA' }}>{fmtDKK(r.indivNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Swedish ISK calculator ────────────────────────────────────────────────────

function SEKCalculator() {
  const [initial,  setInitial]  = useState(100000);
  const [monthly,  setMonthly]  = useState(3000);
  const [ret,      setRet]      = useState(7);
  const [years,    setYears]    = useState(20);
  const [slr,      setSlr]      = useState(2.5);   // statslåneräntan %

  const fmtSEK = v => {
    if (v >= 1e6) return 'SEK ' + (v / 1e6).toFixed(2) + 'm';
    if (v >= 1e3) return 'SEK ' + (v / 1e3).toFixed(0) + 'k';
    return 'SEK ' + Math.round(v).toLocaleString();
  };

  const results = useMemo(() => {
    const mr = Math.pow(1 + ret / 100, 1 / 12) - 1;
    const effectiveISKRate = (slr / 100) * 0.30; // schablonintäkt × 30% kapitalskatt

    const noTax = [initial], isk = [initial], depot = [initial];
    let pNoTax = initial, pISK = initial, pDepot = initial;
    let totalInvested = initial;
    const tableRows = [];

    for (let y = 1; y <= years; y++) {
      totalInvested += monthly * 12;

      const isStart = pISK;
      pNoTax = initial;
      // Recompute no-tax from scratch each year end (already accumulated above)
      // Simpler: just grow each portfolio forward
      let p = pNoTax;
      pNoTax = 0; // reset — we'll just push the accumulated value

      // Actually grow each independently each year
      let ntmp = noTax[y - 1];
      for (let m = 0; m < 12; m++) ntmp = ntmp * (1 + mr) + monthly;
      noTax.push(ntmp);
      pNoTax = ntmp;

      // ISK: annual flat tax on average balance (approx: (start+end)/2 × effectiveISKRate)
      let itmp = isk[y - 1];
      const iskStart = itmp;
      for (let m = 0; m < 12; m++) itmp = itmp * (1 + mr) + monthly;
      const avgISK = (iskStart + itmp) / 2;
      const iskTax = avgISK * effectiveISKRate;
      itmp -= iskTax;
      isk.push(itmp);

      // Regular depot: 30% on total gain at exit
      let dtmp = depot[y - 1];
      for (let m = 0; m < 12; m++) dtmp = dtmp * (1 + mr) + monthly;
      depot.push(dtmp);
      const gainD = dtmp - totalInvested;
      const netDepot = dtmp - (gainD > 0 ? gainD * 0.30 : 0);

      if (y % 5 === 0 || y === years) {
        tableRows.push({ year: y, noTax: ntmp, iskVal: itmp, depotNet: netDepot });
      }
    }

    return { noTax, isk, depot: depot.map((v, y) => {
      const inv = initial + monthly * 12 * y;
      const g = v - inv;
      return v - (g > 0 ? g * 0.30 : 0);
    }), tableRows };
  }, [initial, monthly, ret, years, slr]);

  const series = [
    { key: 'notax', label: 'No tax (theoretical)', color: '#9CA3AF', data: results.noTax, dashed: true },
    { key: 'isk',   label: `ISK (${slr}% statslåneränta × 30%)`, color: '#0f1117', data: results.isk, bold: true },
    { key: 'depot', label: 'Regular depot (30% at exit)', color: '#EA580C', data: results.depot },
  ];

  const numStyle = {
    width: '100%', padding: '7px 10px', border: '1px solid #f0f0f0', borderRadius: 6,
    fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: '#111318',
    background: '#fafafa', outline: 'none', boxSizing: 'border-box',
  };

  const InputRow = ({ label, children }) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6B7280',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );

  const effectiveRate = ((slr / 100) * 0.30 * 100).toFixed(2);

  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🇸🇪</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>
              Swedish ISK Calculator — Investeringssparkonto vs Regular Depot
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
              ISK tax = average account value × <a href="https://www.skatteverket.se" target="_blank" rel="noopener" style={{ color: '#4338CA' }}>statslåneräntan</a> × 30%.
              Current statslåneränta ≈ {slr}% → effective rate ≈ {effectiveRate}% per year on balance.
              Regular depot pays 30% capital gains tax only when you sell.
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24, alignItems: 'start' }}>
        <div>
          <InputRow label="Initial investment (SEK)">
            <input type="number" value={initial} min="0" step="10000"
              onChange={e => setInitial(Number(e.target.value))} style={numStyle} />
          </InputRow>
          <InputRow label="Monthly contribution (SEK)">
            <input type="number" value={monthly} min="0" step="500"
              onChange={e => setMonthly(Number(e.target.value))} style={numStyle} />
          </InputRow>
          <InputRow label={`Annual return: ${ret}%`}>
            <input type="range" value={ret} min="1" max="15" step="0.5"
              onChange={e => setRet(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#0f1117' }} />
          </InputRow>
          <InputRow label={`Investment horizon: ${years} years`}>
            <input type="range" value={years} min="1" max="40" step="1"
              onChange={e => setYears(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#0f1117' }} />
          </InputRow>
          <InputRow label={`Statslåneränta: ${slr}%`}>
            <input type="range" value={slr} min="0.25" max="6" step="0.25"
              onChange={e => setSlr(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#0f1117' }} />
          </InputRow>
          <div style={{ fontSize: 10, color: '#9CA3AF', lineHeight: 1.5 }}>
            Effective ISK rate = {slr}% × 30% = {effectiveRate}% on balance/year.
            ISK is better when returns are high; depot wins at low returns or when you hold long without selling.
          </div>
        </div>

        <div>
          <TaxLineChart series={series} years={years} fmtY={fmtSEK} />
          <ChartLegend series={series} />
        </div>
      </div>

      <div style={{ borderTop: '1px solid #f0f0f0', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
              {['Year','No-tax value','ISK value','Regular depot (net)','ISK vs depot'].map(h => (
                <th key={h} style={{ padding: '8px 14px', textAlign: 'right', fontSize: 10, fontWeight: 700,
                  color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.tableRows.map((r, i) => {
              const diff = r.iskVal - r.depotNet;
              const isISKBetter = diff > 0;
              return (
                <tr key={r.year} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '8px 14px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#111318' }}>{r.year}</td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#9CA3AF' }}>{fmtSEK(r.noTax)}</td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#0f1117' }}>{fmtSEK(r.iskVal)}</td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#EA580C' }}>{fmtSEK(r.depotNet)}</td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace",
                    color: isISKBetter ? '#15803D' : '#DC2626', fontWeight: 500 }}>
                    {isISKBetter ? '+' : ''}{fmtSEK(diff)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── InsightsPage ──────────────────────────────────────────────────────────────

function InsightsPage({ trades, tradesLoading }) {
  const [filter, setFilter] = useState('all');
  const [openEdu, setOpenEdu] = useState(null);

  const FILTERS = [
    { key: 'all',       label: 'All' },
    { key: 'tools',     label: 'Tools' },
    { key: 'brokers',   label: 'Broker Guides' },
    { key: 'education', label: 'Education' },
  ];

  const showTools     = filter === 'all' || filter === 'tools';
  const showBrokers   = filter === 'all' || filter === 'brokers';
  const showEducation = filter === 'all' || filter === 'education';

  function SectionLabel({ children }) {
    return (
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: '#9CA3AF', fontFamily: "'JetBrains Mono', monospace",
        marginBottom: 12,
      }}>{children}</div>
    );
  }

  return (
    <main style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 32px' }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>
            Insights & Research
          </h1>
          <p style={{ fontSize: 13, color: '#6B7280' }}>
            Tax calculators, broker guides, and educational content for European investors.
          </p>
        </div>

        {/* Filter tabs */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 28,
          background: '#f8f8f8', border: '1px solid #f0f0f0',
          borderRadius: 8, padding: 3, width: 'fit-content',
        }}>
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: '5px 14px', borderRadius: 6, border: 'none',
              background: filter === f.key ? '#fff' : 'transparent',
              color: filter === f.key ? '#111318' : '#9CA3AF',
              fontWeight: filter === f.key ? 600 : 400,
              fontSize: 12, fontFamily: "'Inter', sans-serif", cursor: 'pointer',
              boxShadow: filter === f.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.12s', whiteSpace: 'nowrap',
            }}>{f.label}</button>
          ))}
        </div>

        {/* ── Tools ─────────────────────────────────────────────────────── */}
        {showTools && (
          <div style={{ marginBottom: 36 }}>
            <SectionLabel>Tax Calculators</SectionLabel>
            <DKCalculator />
            <SEKCalculator />
          </div>
        )}

        {/* ── Broker Guides ─────────────────────────────────────────────── */}
        {showBrokers && (
          <div style={{ marginBottom: 36 }}>
            <SectionLabel>Broker Guides</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {BROKER_GUIDES.map((g, i) => (
                <div key={i} style={{
                  background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10,
                  padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8,
                  position: 'relative',
                }}>
                  <div style={{
                    position: 'absolute', top: 12, right: 12,
                    fontSize: 9, color: '#9CA3AF', background: '#f8f8f8',
                    border: '1px solid #f0f0f0', borderRadius: 3,
                    padding: '1px 5px', fontWeight: 600, letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}>Affiliate</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#6B7280',
                    textTransform: 'uppercase', letterSpacing: '0.07em' }}>{g.tag}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111318', lineHeight: 1.4, paddingRight: 48 }}>{g.title}</div>
                  <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.55, flex: 1 }}>{g.desc}</div>
                  <a href="#" onClick={e => e.preventDefault()} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 12, fontWeight: 600, color: ACCENT,
                    textDecoration: 'none', marginTop: 4, fontFamily: "'Inter', sans-serif",
                  }}>
                    Read Guide
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                    </svg>
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Education ─────────────────────────────────────────────────── */}
        {showEducation && (
          <div style={{ marginBottom: 20 }}>
            <SectionLabel>Education</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {EDUCATION_ITEMS.map((item, i) => {
                const isOpen = openEdu === i;
                return (
                  <div key={i} style={{
                    background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10, overflow: 'hidden',
                  }}>
                    <button onClick={() => setOpenEdu(isOpen ? null : i)} style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '13px 18px', background: 'none', border: 'none', cursor: 'pointer',
                      textAlign: 'left', gap: 12,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: '#6B7280',
                          textTransform: 'uppercase', letterSpacing: '0.07em',
                          background: '#f8f8f8', border: '1px solid #f0f0f0',
                          borderRadius: 3, padding: '2px 6px', flexShrink: 0,
                        }}>{item.tag}</span>
                        <span style={{ fontSize: 13, fontWeight: 500, color: '#111318' }}>{item.title}</span>
                      </div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round"
                        style={{ flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '0 18px 14px', fontSize: 13, color: '#6B7280',
                        lineHeight: 1.65, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
                        {item.body}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </main>
  );
}

// ─── PricingPage ──────────────────────────────────────────────────────────────

const PLAN_FEATURES_GRID = [
  { category: 'Data Access', rows: [
    { label: 'Markets covered',         analyst: '13 European',  strategist: '13 European',    terminal: '13 European' },
    { label: 'Transaction history',     analyst: 'First 50 rows', strategist: 'Full 180 days', terminal: 'Full 180 days' },
    { label: 'Company page history',    analyst: 'Last 3 trades', strategist: 'Unlimited',      terminal: 'Unlimited' },
    { label: 'Data updates',            analyst: 'Daily',         strategist: 'Daily',          terminal: 'Daily' },
  ]},
  { category: 'Signals & Alerts', rows: [
    { label: 'Conviction scoring',      analyst: 'First 50 rows', strategist: true,             terminal: true },
    { label: 'Signal badges (📉 🔁 🔄 📅)', analyst: 'First 50 rows', strategist: true,         terminal: true },
    { label: 'Alerts feed',             analyst: false,           strategist: true,             terminal: true },
    { label: 'Cluster buy detection',   analyst: false,           strategist: true,             terminal: true },
  ]},
  { category: 'Tools & Research', rows: [
    { label: 'Top Insiders leaderboard', analyst: 'Top 10',      strategist: 'Full',           terminal: 'Full' },
    { label: 'Insider performance profiles', analyst: false,     strategist: true,             terminal: true },
    { label: 'Personal watchlist',      analyst: 'Demo only',    strategist: 'Unlimited',      terminal: 'Unlimited' },
    { label: 'Buyback program tracking', analyst: true,          strategist: true,             terminal: true },
    { label: 'Tax calculators',         analyst: true,           strategist: true,             terminal: true },
  ]},
  { category: 'Export & API', rows: [
    { label: 'CSV data export',         analyst: false,           strategist: false,            terminal: 'Coming soon' },
    { label: 'API access',              analyst: false,           strategist: false,            terminal: 'Coming soon' },
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

function PricingPage({ session, onLogin }) {
  const [billing,      setBilling]      = useState('annual');
  const [hoveredPlan,  setHoveredPlan]  = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null); // planId being loaded

  async function startCheckout(plan) {
    if (!session) { onLogin?.(); return; }
    setCheckoutLoading(plan.id);
    const priceId = billing === 'annual'
      ? (plan.id === 'elite' ? import.meta.env.VITE_STRIPE_PRICE_ELITE_ANNUAL   : import.meta.env.VITE_STRIPE_PRICE_PRO_ANNUAL)
      : (plan.id === 'elite' ? import.meta.env.VITE_STRIPE_PRICE_ELITE_MONTHLY  : import.meta.env.VITE_STRIPE_PRICE_PRO_MONTHLY);

    try {
      const res  = await fetch('/api/create-checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ priceId, userId: session.user.id, userEmail: session.user.email }),
      });
      const { url, error } = await res.json();
      if (error) throw new Error(error);
      window.location.href = url;
    } catch (err) {
      console.error('[checkout]', err.message);
      setCheckoutLoading(null);
    }
  }

  const plans = [
    {
      id: 'free', tier: 'Free',
      tagline: 'Try it — no account needed',
      monthly: 0, annual: 0, highlight: false,
      bullets: [
        'First 50 insider trades with full data',
        'Last 3 transactions on company pages',
        'Top 10 insiders on leaderboard',
        'Demo watchlist (7 pre-loaded stocks)',
        'Stock charts with trade markers',
        'All tax calculators & education',
        '13 European markets',
      ],
    },
    {
      id: 'pro', tier: 'Pro',
      tagline: 'For investors who want the full picture',
      monthly: 12, annual: 9.99, annualBilled: 119.88, highlight: true,
      bullets: [
        'Unlimited insider transactions (180 days)',
        'Full company transaction history',
        'Full Top Insiders leaderboard',
        'Personal watchlist — unlimited stocks',
        'Full alerts feed (conviction, cluster, large)',
        'All signal badges & conviction scores',
        'Insider performance profiles & track records',
        'Buyback program tracking',
      ],
    },
    {
      id: 'elite', tier: 'Elite',
      tagline: 'For power users who need everything',
      monthly: 18, annual: 14.99, annualBilled: 179.88, highlight: false,
      bullets: [
        'Everything in Pro',
        'CSV data export',
        'API access (coming soon)',
        'Priority support',
      ],
    },
  ];

  const annualSave = 17; // ~17% saving: €9.99/mo vs €12/mo

  const proofItems = [
    { label: 'Avg 30d return (profitable buys)', value: '+18.8%', sub: 'from our database',  color: '#16A34A' },
    { label: 'High conviction buys tracked',      value: '157',   sub: 'in the last 14 days', color: ACCENT },
    { label: 'Insider transactions',              value: '7,000+',sub: '180-day rolling window', color: '#6B7280' },
    { label: 'Markets covered',                   value: '13',    sub: 'European regulators', color: '#6B7280' },
  ];

  return (
    <main style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>
      {/* Hero */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '72px 40px 60px', textAlign: 'center' }}>
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
                    {plan.monthly === 0 ? (
                      <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: '-0.04em', color: '#0C0F1A', lineHeight: 1, fontFamily: "'JetBrains Mono', monospace", marginBottom: 8 }}>Free</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, marginBottom: 4 }}>
                          <span style={{ fontSize: 28, fontWeight: 700, color: '#6B7280', marginBottom: 6, lineHeight: 1, fontFamily: "'JetBrains Mono', monospace" }}>€</span>
                          <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: '-0.04em', color: '#0C0F1A', lineHeight: 1, fontFamily: "'JetBrains Mono', monospace" }}>
                            {price}
                          </span>
                          <span style={{ fontSize: 13, color: '#9CA3AF', marginBottom: 8 }}>/mo</span>
                        </div>
                        {billing === 'annual' && plan.annualBilled ? (
                          <div style={{ fontSize: 12, color: '#9CA3AF' }}>€{plan.annualBilled}/year billed annually</div>
                        ) : plan.monthly > 0 ? (
                          <div style={{ fontSize: 12, color: '#9CA3AF' }}>Or €{plan.annual}/mo billed annually</div>
                        ) : null}
                      </>
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
                  }} onClick={() => plan.monthly > 0 && startCheckout(plan)}
                     disabled={checkoutLoading === plan.id}>
                    {plan.monthly === 0
                      ? 'Get started free'
                      : checkoutLoading === plan.id
                        ? 'Redirecting…'
                        : plan.id === 'elite' ? 'Start Elite →' : 'Start Pro →'}
                  </button>
                  <div style={{ textAlign: 'center', fontSize: 11, color: '#9CA3AF', marginTop: 8 }}>
                    {plan.monthly === 0 ? 'No account required' : 'Cancel any time'}
                  </div>
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
              {['Free', 'Pro', 'Elite'].map((name, i) => (
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
              { q: 'How many markets do you cover?', a: '13 European markets: Belgium, Switzerland, Denmark, Spain, Finland, France, Germany, Italy, South Korea, Netherlands, Norway, Sweden, and the United Kingdom. All filings come from official national regulators (AFM, AMF, BaFin, CNMV, Finanstilsynet, FCA, FSMA, SKAT, etc.).' },
              { q: 'How far back does data go?', a: 'We maintain a 180-day rolling window of insider transactions across all covered markets. Data is refreshed daily via automated scrapers.' },
              { q: 'How often is data updated?', a: 'Daily — automated scrapers run every night via GitHub Actions, processing filings published by regulators within the previous 24 hours.' },
              { q: 'What signals do you track?', a: 'Four signals: Conviction score (trade size × role seniority × timing), Cluster buying (2+ insiders at the same company within 14 days), Repetitive buying (same insider buying multiple times within 14 days), and Price dip (insider bought after a significant drawdown).' },
              { q: 'How is the Conviction Score calculated?', a: 'It weights transaction size, ownership change percentage, role seniority (CEO/CFO score higher than board members), and whether the purchase followed a price decline. Scores are visible on all trades for Pro and Elite users.' },
              { q: 'Can I cancel at any time?', a: 'Yes. Cancel any time from your account settings. No long-term commitment required.' },
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

  // ── Dynamic meta tags ──────────────────────────────────────────────────────
  useMetaTags(page, selectedCompany, selectedInsider);

  // ── Auth state ──────────────────────────────────────────────────────────────
  const [session, setSession] = useState(null);
  const [userPlan, setUserPlan] = useState('visitor');
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('checkout') === 'success'
  );
  const access = useAccess(userPlan);

  async function fetchUserPlan(userId, userEmail) {
    const { data } = await supabase
      .from('user_profiles')
      .select('plan')
      .eq('id', userId)
      .maybeSingle();
    if (!data) {
      // New user — create profile
      await supabase.from('user_profiles').insert({ id: userId, email: userEmail, plan: 'visitor' });
      setUserPlan('visitor');
    } else {
      setUserPlan(data.plan || 'visitor');
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s) fetchUserPlan(s.user.id, s.user.email);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s) fetchUserPlan(s.user.id, s.user.email);
      else setUserPlan('visitor');
    });
    return () => subscription.unsubscribe();
  }, []);

  function handleSignOut() {
    supabase.auth.signOut();
    setUserPlan('visitor');
  }

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
    track('add_to_watchlist', { ticker: stock.ticker, company: stock.company });
    return true;
  }

  const watchlistTickers = useMemo(() => new Set(watchlist.map(w => w.ticker)), [watchlist]);
  const alertCount = useAlertCount(trades, watchlistTickers);

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
    track('view_insider', { insider_name: name });
  }

  function handleCompanyClick(ticker, company, countryCode) {
    pushNav();
    const wl = watchlist.find(w => w.ticker === ticker && w.country_code === countryCode);
    setSelectedCompany({ ticker, company, countryCode, yahooTicker: wl?.yahoo_ticker || null });
    setPage('company');
    track('view_company', { company_name: company, ticker, country: countryCode });
  }

  function toggleCountry(code) {
    setSelectedCountries(prev => {
      const next = new Set(prev);
      const adding = !next.has(code);
      adding ? next.add(code) : next.delete(code);
      if (adding) track('filter_country', { country: code });
      return next;
    });
  }
  function clearCountries() { setSelectedCountries(new Set()); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#ffffff' }}>
      <TopBar
        page={page}
        setPage={p => { setPage(p); setNavStack([]); setSelectedInsider(null); setSelectedCompany(null); }}
        search={search} setSearch={setSearch}
        alertCount={alertCount}
        session={session}
        isAdmin={access.isAdmin}
        isElite={access.isElite}
        onLogin={() => setShowLoginModal(true)}
        onSignOut={handleSignOut}
      />
      {showLoginModal && <LoginModal onClose={() => setShowLoginModal(false)} />}
      {checkoutSuccess && (
        <div style={{
          background: '#F0FDF4', borderBottom: '1px solid #BBF7D0',
          padding: '10px 24px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ fontSize: 13, color: '#15803D', fontWeight: 500 }}>
            🎉 Payment successful! Your plan has been activated. Refresh if you don't see the upgrade yet.
          </span>
          <button onClick={() => { setCheckoutSuccess(false); window.history.replaceState({}, '', '/'); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#16A34A', padding: '0 4px' }}>×</button>
        </div>
      )}
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
            access={access}
            onLogin={() => setShowLoginModal(true)}
            onUpgrade={() => setPage('pricing')}
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
            alertCount={alertCount}
            access={access}
            onUpgrade={() => setPage('pricing')}
            onLogin={() => setShowLoginModal(true)}
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
            access={access}
            onUpgrade={() => setPage('pricing')}
          />
        )}
        {page === 'insights' && (
          <InsightsPage trades={trades} tradesLoading={tradesLoading} />
        )}
        {page === 'pricing' && <PricingPage session={session} onLogin={() => setShowLoginModal(true)} />}
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
              access={access}
            />
          </Suspense>
        )}
      </div>
      <Footer />
    </div>
  );
}
