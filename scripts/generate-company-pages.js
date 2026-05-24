'use strict';
// Generates / refreshes SEO company pages from live DB data.
// Usage:  node scripts/generate-company-pages.js [--limit N]
// Cron:   0 8 * * 0  cd /opt/insider-tracker && node scripts/generate-company-pages.js

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const LIMIT      = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i+1]) : 100; })();
const OUT_DIR    = path.resolve(__dirname, '../frontend/public/company');
const SITEMAP    = path.resolve(__dirname, '../frontend/public/sitemap.xml');
const BASE_URL   = 'https://www.insidersalpha.com';
const YEAR       = new Date().getFullYear();
const TODAY      = new Date().toISOString().slice(0, 10);
const CUTOFF_30D = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// ── Country metadata ──────────────────────────────────────────────────────────

const COUNTRY = {
  IT: { name: 'Italy',          flag: '🇮🇹', exchange: 'Euronext Milan',         regulator: 'Consob',             mktSlug: 'italy' },
  FR: { name: 'France',         flag: '🇫🇷', exchange: 'Euronext Paris',         regulator: 'AMF',                mktSlug: 'france' },
  DE: { name: 'Germany',        flag: '🇩🇪', exchange: 'Xetra',                  regulator: 'BaFin',              mktSlug: 'germany' },
  ES: { name: 'Spain',          flag: '🇪🇸', exchange: 'Madrid Stock Exchange',  regulator: 'CNMV',               mktSlug: 'spain' },
  BE: { name: 'Belgium',        flag: '🇧🇪', exchange: 'Euronext Brussels',      regulator: 'FSMA',               mktSlug: 'belgium' },
  NL: { name: 'Netherlands',    flag: '🇳🇱', exchange: 'Euronext Amsterdam',     regulator: 'AFM',                mktSlug: 'netherlands' },
  FI: { name: 'Finland',        flag: '🇫🇮', exchange: 'Nasdaq Helsinki',        regulator: 'FIN-FSA',            mktSlug: 'finland' },
  DK: { name: 'Denmark',        flag: '🇩🇰', exchange: 'Nasdaq Copenhagen',      regulator: 'Danish FSA',         mktSlug: 'denmark' },
  NO: { name: 'Norway',         flag: '🇳🇴', exchange: 'Oslo Børs',              regulator: 'Finanstilsynet',     mktSlug: 'norway' },
  SE: { name: 'Sweden',         flag: '🇸🇪', exchange: 'Nasdaq Stockholm',       regulator: 'Finansinspektionen', mktSlug: 'sweden' },
  CH: { name: 'Switzerland',    flag: '🇨🇭', exchange: 'SIX Swiss Exchange',     regulator: 'FINMA',              mktSlug: 'switzerland' },
  GB: { name: 'United Kingdom', flag: '🇬🇧', exchange: 'London Stock Exchange',  regulator: 'FCA',                mktSlug: 'united-kingdom' },
  PT: { name: 'Portugal',       flag: '🇵🇹', exchange: 'Euronext Lisbon',        regulator: 'CMVM',               mktSlug: 'portugal' },
  LU: { name: 'Luxembourg',     flag: '🇱🇺', exchange: 'Luxembourg SE',          regulator: 'CSSF',               mktSlug: 'luxembourg' },
  KR: { name: 'South Korea',    flag: '🇰🇷', exchange: 'Korea Exchange',         regulator: 'FSC/FSS',            mktSlug: 'south-korea' },
};

const CURRENCY = {
  IT:'EUR', FR:'EUR', DE:'EUR', ES:'EUR', BE:'EUR',
  NL:'EUR', FI:'EUR', PT:'EUR', LU:'EUR',
  NO:'NOK', SE:'SEK', DK:'DKK', CH:'CHF', GB:'GBP', KR:'KRW',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatValue(val, cc) {
  const v = Math.abs(Number(val || 0));
  if (!v) return '—';
  const cur = CURRENCY[cc] || 'EUR';
  const sym = { EUR:'€', GBP:'£', CHF:'CHF ', SEK:'SEK ', NOK:'NOK ', DKK:'DKK ', KRW:'₩' }[cur] || '';
  if (cur === 'KRW') {
    if (v >= 1e12) return `₩${(v/1e12).toFixed(1)}T`;
    if (v >= 1e9)  return `₩${(v/1e9).toFixed(1)}B`;
    if (v >= 1e6)  return `₩${(v/1e6).toFixed(0)}M`;
    return `₩${v.toLocaleString('en')}`;
  }
  if (v >= 1e9)  return `${sym}${(v/1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `${sym}${(v/1e6).toFixed(2)}M`;
  if (v >= 1e3)  return `${sym}${(v/1e3).toFixed(1)}K`;
  return `${sym}${v.toFixed(0)}`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function buyTrend(buys, sells) {
  if (buys + sells === 0) return 'mixed';
  const r = buys / (buys + sells);
  if (r >= 0.75) return 'bullish — insiders are predominantly buying';
  if (r >= 0.5)  return 'moderately bullish — more buying than selling';
  if (r <= 0.25) return 'bearish — insiders are predominantly selling';
  return 'mixed — showing both buying and selling';
}

function makeSlug(ticker) {
  return ticker.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── Fetch all transactions (single pass) ─────────────────────────────────────

async function fetchAllTransactions() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_transactions')
      .select('id, company, ticker, country_code, transaction_type, transaction_date, insider_name, via_entity, insider_role, shares, price_per_share, total_value, is_cluster_buy, is_price_dip, is_pre_earnings, is_repetitive_buy, conviction_label')
      .not('ticker', 'is', null)
      .neq('ticker', '')
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// ── Aggregate top companies ───────────────────────────────────────────────────

function aggregateCompanies(rows, limit) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!map.has(key)) {
      map.set(key, { company: r.company, ticker: r.ticker, country_code: r.country_code,
        total: 0, buys: 0, sells: 0, last: '', totalVal: 0 });
    }
    const g = map.get(key);
    g.total++;
    const tp = (r.transaction_type || '').toUpperCase();
    if (tp === 'BUY' || tp === 'PURCHASE') g.buys++;
    else if (tp === 'SELL' || tp === 'SALE') g.sells++;
    if ((r.transaction_date || '') > g.last) g.last = r.transaction_date;
    g.totalVal += Number(r.total_value || 0);
  }
  return [...map.values()]
    .filter(r => r.total >= 3)
    .sort((a, b) => b.totalVal - a.totalVal)
    .slice(0, limit);
}

// ── HTML generator ────────────────────────────────────────────────────────────

function generateHTML(co, txns) {
  const cc    = co.country_code;
  const ctry  = COUNTRY[cc] || { name: cc, flag: '', exchange: cc, regulator: cc, mktSlug: cc.toLowerCase() };
  const cur   = CURRENCY[cc] || 'EUR';

  // Sort by date desc, take recent 5
  const sorted  = [...txns].sort((a, b) => (b.transaction_date || '').localeCompare(a.transaction_date || ''));
  const recent5 = sorted.slice(0, 5);
  const latestBuy = sorted.find(t => { const tp=(t.transaction_type||'').toUpperCase(); return tp==='BUY'||tp==='PURCHASE'; });
  const largest   = txns.reduce((best, t) => Number(t.total_value||0) > Number(best?.total_value||0) ? t : best, null);

  // Named insiders (real people, up to 5)
  const namedInsiders = [...new Set(
    sorted.filter(t => t.insider_name && t.insider_name !== 'Not disclosed').map(t => t.insider_name)
  )].slice(0, 5);

  // Signals present in last 90d
  const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const recent90 = txns.filter(t => (t.transaction_date || '') >= cutoff90);
  const hasCluster    = recent90.some(t => t.is_cluster_buy);
  const hasPriceDip   = recent90.some(t => t.is_price_dip);
  const hasPreEarnings = recent90.some(t => t.is_pre_earnings);
  const hasRepetitive = recent90.some(t => t.is_repetitive_buy);

  const trend  = buyTrend(co.buys, co.sells);
  const isRecent = (co.last || '') >= CUTOFF_30D;

  // Meta description
  const metaDesc = latestBuy
    ? `Track insider buying at ${co.company} (${co.ticker}). ${co.total} insider transactions tracked. Latest: ${(latestBuy.insider_name || 'An insider').slice(0, 40)} purchased ${formatValue(latestBuy.total_value, cc)} on ${latestBuy.transaction_date}. Real-time MAR Art.19 data.`
    : `Track insider buying and selling at ${co.company} (${co.ticker}). ${co.total} transactions tracked. Real-time MAR Art.19 disclosures from ${ctry.regulator}.`;

  // ── Recent transactions table ─────────────────────────────────────────────
  const recentRows = recent5.map(t => {
    const tp     = (t.transaction_type || '').toUpperCase();
    const isBuy  = tp === 'BUY' || tp === 'PURCHASE';
    const insName = t.insider_name || (t.via_entity ? `Via ${t.via_entity}` : 'Undisclosed');
    const badges = [
      t.is_cluster_buy    ? '🔄' : '',
      t.is_price_dip      ? '📉' : '',
      t.is_pre_earnings   ? '📅' : '',
      t.is_repetitive_buy ? '🔁' : '',
    ].filter(Boolean).join(' ');
    return `<tr>
          <td>${esc(t.transaction_date || '—')}</td>
          <td class="truncate" title="${esc(insName)}">${esc(insName.slice(0, 28))}</td>
          <td class="role-cell truncate">${esc((t.insider_role || '').slice(0, 22))}</td>
          <td><span class="${isBuy ? 'type-buy' : 'type-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
          <td>${t.shares ? Number(t.shares).toLocaleString('en') : '—'}</td>
          <td>${t.price_per_share ? formatValue(t.price_per_share, cc) : '—'}</td>
          <td style="font-weight:600">${formatValue(t.total_value, cc)}</td>
          <td>${badges || '—'}</td>
        </tr>`;
  }).join('\n');

  // ── Key insiders list ─────────────────────────────────────────────────────
  const insiderRows = namedInsiders.map(name => {
    const its   = txns.filter(t => t.insider_name === name);
    const role  = its[0]?.insider_role || '';
    const buys  = its.filter(t => { const tp=(t.transaction_type||'').toUpperCase(); return tp==='BUY'||tp==='PURCHASE'; }).length;
    const initials = name.split(' ').map(n => n[0]).filter(Boolean).join('').slice(0, 2).toUpperCase();
    return `<div class="insider-row">
          <div class="insider-avatar">${esc(initials)}</div>
          <div class="insider-info">
            <div class="insider-name">${esc(name)}</div>
            ${role ? `<div class="insider-role">${esc(role)}</div>` : ''}
            <div class="insider-stats">${its.length} filing${its.length !== 1 ? 's' : ''} · ${buys} buy${buys !== 1 ? 's' : ''}</div>
          </div>
        </div>`;
  }).join('\n');

  // ── Signal badges ─────────────────────────────────────────────────────────
  const sigBadges = [
    hasCluster    && '<span class="sig sig-cluster">🔄 Cluster buy</span>',
    hasPriceDip   && '<span class="sig sig-dip">📉 Price dip buy</span>',
    hasPreEarnings && '<span class="sig sig-earnings">📅 Pre-earnings buy</span>',
    hasRepetitive && '<span class="sig sig-repeat">🔁 Repeat buyer</span>',
  ].filter(Boolean).join('\n        ');

  // ── JSON-LD ───────────────────────────────────────────────────────────────
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'InsidersAlpha', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: `${ctry.flag} ${ctry.name} Insider Transactions`, item: `${BASE_URL}/market/${ctry.mktSlug}-insider-transactions` },
      { '@type': 'ListItem', position: 3, name: co.company, item: `${BASE_URL}/company/${co.slug}-insider-transactions` },
    ],
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `Who are the insiders at ${co.company}?`,
        acceptedAnswer: { '@type': 'Answer', text:
          namedInsiders.length > 0
            ? `Insiders at ${co.company} who have disclosed transactions include: ${namedInsiders.join(', ')}. These are PDMRs (Persons Discharging Managerial Responsibilities) who filed with ${ctry.regulator} under MAR Article 19.`
            : `Insider transactions at ${co.company} are tracked from ${ctry.regulator} filings. InsidersAlpha has recorded ${co.total} total transactions.`,
        },
      },
      {
        '@type': 'Question',
        name: `When was the last insider buy at ${co.company}?`,
        acceptedAnswer: { '@type': 'Answer', text:
          latestBuy
            ? `The most recent insider purchase at ${co.company} was by ${latestBuy.insider_name || 'an insider'} on ${latestBuy.transaction_date}, worth ${formatValue(latestBuy.total_value, cc)}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`
            : `The most recent insider filing at ${co.company} was recorded on ${co.last || TODAY}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`,
        },
      },
      {
        '@type': 'Question',
        name: `Is ${co.company} stock a good buy based on insider activity?`,
        acceptedAnswer: { '@type': 'Answer', text:
          `InsidersAlpha tracks ${co.total} insider transactions at ${co.company}. The buy/sell ratio is ${co.buys}:${co.sells} (${co.buys} buys vs ${co.sells} sells). Insider activity is ${trend}. Past performance does not guarantee future results.`,
        },
      },
      {
        '@type': 'Question',
        name: `Where is ${co.company} listed?`,
        acceptedAnswer: { '@type': 'Answer', text:
          `${co.company} (${co.ticker}) is listed on ${ctry.exchange} in ${ctry.name}. Insider transactions are disclosed to ${ctry.regulator} under MAR Article 19.`,
        },
      },
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(co.company)} Insider Transactions & Buying Signals ${YEAR} | InsidersAlpha</title>
  <meta name="description" content="${esc(metaDesc)}">
  <meta property="og:title" content="${esc(co.company)} (${esc(co.ticker)}) Insider Transactions | InsidersAlpha">
  <meta property="og:description" content="${esc(metaDesc)}">
  <meta property="og:url" content="${BASE_URL}/company/${co.slug}-insider-transactions">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${BASE_URL}/company/${co.slug}-insider-transactions">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-RPT36NKE74"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-RPT36NKE74');</script>
  <script type="application/ld+json">${breadcrumbLd}</script>
  <script type="application/ld+json">${faqLd}</script>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',-apple-system,sans-serif;background:#fff;color:#111318;line-height:1.6;font-size:15px}
    a{color:#111318;text-decoration:none}a:hover{text-decoration:underline}
    .nav{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;padding:0 24px;height:56px;gap:12px}
    .nav a{font-size:13px;color:#6B7280}.nav a:hover{color:#111318}
    .nav-logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:15px;letter-spacing:-.02em;color:#111318;margin-right:auto}
    .breadcrumb{font-size:12px;color:#9CA3AF;margin-bottom:20px}
    .breadcrumb a{color:#9CA3AF}.breadcrumb a:hover{color:#111318}
    .breadcrumb span{margin:0 6px}
    .wrap{max-width:800px;margin:0 auto;padding:48px 24px 80px}
    h1{font-size:30px;font-weight:700;letter-spacing:-.025em;margin-bottom:8px}
    h2{font-size:18px;font-weight:700;margin:28px 0 12px}
    h3{font-size:15px;font-weight:600;margin:0 0 6px}
    p{color:#374151;margin-bottom:14px;line-height:1.7}
    .hero-sub{font-size:16px;color:#6B7280;margin-bottom:6px}
    .updated-note{font-size:11px;color:#9CA3AF;margin-bottom:20px}
    .meta-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
    .meta-tag{background:#f8f8f8;border:1px solid #f0f0f0;border-radius:6px;padding:6px 12px}
    .meta-tag strong{display:block;font-size:10px;color:#9CA3AF;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;font-family:'JetBrains Mono',monospace}
    .meta-tag span{color:#111318;font-size:13px;font-family:'JetBrains Mono',monospace}
    .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    @media(max-width:540px){.stats-grid{grid-template-columns:1fr 1fr}}
    .stat-card{border:1px solid #f0f0f0;border-radius:8px;padding:14px 16px;text-align:center}
    .stat-card .val{font-size:22px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-.02em;margin-bottom:2px}
    .stat-card .val.small{font-size:14px}
    .stat-card .lbl{font-size:11px;color:#9CA3AF;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
    .signal-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:20px}
    .sig{display:inline-block;border-radius:5px;padding:4px 10px;font-size:12px;font-weight:600}
    .sig-cluster{background:#EEF2FF;color:#4338CA}
    .sig-dip{background:#FEF9C3;color:#854D0E}
    .sig-earnings{background:#FFF7ED;color:#C2410C}
    .sig-repeat{background:#F5F3FF;color:#7C3AED}
    .cta-box{background:#0f1117;border-radius:10px;padding:22px 28px;margin:24px 0 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .cta-box p{color:#9CA3AF;font-size:13px;margin:0}
    .cta-box strong{display:block;color:#fff;font-size:15px;font-weight:700;margin-bottom:3px}
    .cta-btn{display:inline-block;background:#fff;color:#0f1117;border-radius:7px;padding:9px 18px;font-size:13px;font-weight:700;white-space:nowrap}
    .cta-btn:hover{background:#f0f0f0;text-decoration:none}
    .txn-table-wrap{overflow-x:auto;margin-bottom:8px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:9px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#9CA3AF;border-bottom:2px solid #f0f0f0;white-space:nowrap}
    td{padding:10px 10px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover{background:#fafafa}
    .type-buy{background:#DCFCE7;color:#15803D;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700}
    .type-sell{background:#FEE2E2;color:#DC2626;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700}
    .truncate{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .role-cell{color:#6B7280}
    .insider-list{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}
    .insider-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #f0f0f0;border-radius:8px}
    .insider-avatar{width:36px;height:36px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#374151;flex-shrink:0;font-family:'JetBrains Mono',monospace}
    .insider-name{font-weight:600;font-size:13px;color:#111318}
    .insider-role{font-size:12px;color:#6B7280;margin-top:1px}
    .insider-stats{font-size:11px;color:#9CA3AF;margin-top:2px}
    .faq-item{border-bottom:1px solid #f0f0f0;padding:16px 0}
    .faq-item:last-child{border-bottom:none}
    .link-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}
    .chip{display:inline-block;background:#f8f8f8;border:1px solid #f0f0f0;border-radius:5px;padding:5px 12px;font-size:13px;color:#374151}
    .chip:hover{background:#f0f0f0;text-decoration:none}
    .divider{height:1px;background:#f0f0f0;margin:28px 0}
    footer{border-top:1px solid #f0f0f0;padding:20px 24px;text-align:center;font-size:12px;color:#9CA3AF}
    footer a{color:#9CA3AF;margin:0 8px}footer a:hover{color:#111318}
    @media(max-width:600px){.role-cell{display:none}th,td{padding:8px 6px}.wrap{padding:32px 16px 60px}}
  </style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">
    <svg width="26" height="26" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <rect width="36" height="36" rx="5" fill="#0f1117"/>
      <rect x="4" y="6" width="6" height="24" fill="white"/>
      <polygon points="17,6 20,6 24,30 21,30" fill="white"/>
      <polygon points="17,6 20,6 16,30 13,30" fill="white"/>
      <rect x="14" y="19" width="9" height="3" fill="white"/>
    </svg>
    InsidersAlpha
  </a>
  <a href="/">← Back to app</a>
</nav>

<main class="wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/">InsidersAlpha</a><span>›</span>
    <a href="/market/${ctry.mktSlug}-insider-transactions">${ctry.flag} ${ctry.name}</a><span>›</span>
    ${esc(co.company)}
  </nav>

  <h1>${esc(co.company)} (${esc(co.ticker)}) Insider Transactions</h1>
  <p class="hero-sub">Track insider buying and selling at ${esc(co.company)}. ${co.total} transactions on record — real-time MAR Art.19 data from ${ctry.regulator}.</p>
  <p class="updated-note">Last updated: ${TODAY}</p>

  <div class="meta-row">
    <div class="meta-tag"><strong>Ticker</strong><span>${esc(co.ticker)}</span></div>
    <div class="meta-tag"><strong>Exchange</strong><span>${esc(ctry.exchange)}</span></div>
    <div class="meta-tag"><strong>Country</strong><span>${ctry.flag} ${ctry.name}</span></div>
    <div class="meta-tag"><strong>Regulator</strong><span>${esc(ctry.regulator)}</span></div>
    <div class="meta-tag"><strong>Last filing</strong><span>${co.last || '—'}</span></div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="val">${co.total}</div>
      <div class="lbl">Total filings</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#15803D">${co.buys}</div>
      <div class="lbl">Insider buys</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#DC2626">${co.sells}</div>
      <div class="lbl">Insider sells</div>
    </div>
    <div class="stat-card">
      <div class="val">${co.buys + co.sells > 0 ? (co.buys / (co.buys + co.sells) * 100).toFixed(0) + '%' : '—'}</div>
      <div class="lbl">Buy ratio</div>
    </div>
    <div class="stat-card">
      <div class="val small">${co.last || '—'}</div>
      <div class="lbl">Last activity</div>
    </div>
    <div class="stat-card">
      <div class="val ${largest && Number(largest.total_value) >= 1e6 ? 'small' : ''}">${largest ? formatValue(largest.total_value, cc) : '—'}</div>
      <div class="lbl">Largest trade</div>
    </div>
  </div>

  ${sigBadges ? `<div class="signal-row">\n        ${sigBadges}\n      </div>` : ''}

  <div class="cta-box">
    <div>
      <strong>Live ${esc(co.company)} insider transactions</strong>
      <p>Real-time filings with conviction scores, signal badges, and post-trade performance tracking.</p>
    </div>
    <a href="/" class="cta-btn">See all transactions →</a>
  </div>

  ${recent5.length > 0 ? `
  <h2>Recent insider transactions at ${esc(co.company)}</h2>
  <div class="txn-table-wrap">
    <table>
      <thead><tr>
        <th>Date</th><th>Insider</th><th class="role-cell">Role</th>
        <th>Type</th><th>Shares</th><th>Price</th><th>Value</th><th>Signals</th>
      </tr></thead>
      <tbody>
        ${recentRows}
      </tbody>
    </table>
  </div>` : ''}

  ${namedInsiders.length > 0 ? `
  <div class="divider"></div>
  <h2>Named insiders at ${esc(co.company)}</h2>
  <div class="insider-list">
    ${insiderRows}
  </div>` : ''}

  <div class="divider"></div>

  <h2>About ${esc(co.company)} insider disclosures</h2>
  <p>InsidersAlpha tracks ${co.total} disclosed insider transactions at ${esc(co.company)} sourced from ${ctry.regulator}. Of these, ${co.buys} are purchase transactions and ${co.sells} are sales. All data is sourced from official regulatory filings under MAR Article 19 and updated daily.</p>
  ${largest && Number(largest.total_value) > 0 ? `<p>The largest single transaction recorded was worth ${formatValue(largest.total_value, cc)}${largest.insider_name ? ` by ${esc(largest.insider_name)}` : ''} on ${largest.transaction_date}.</p>` : ''}
  <p>Insider trading disclosures at ${esc(co.company)} are filed with ${ctry.regulator} within 3 business days of each transaction, as required by the EU Market Abuse Regulation (MAR) Article 19.</p>

  <div class="divider"></div>

  <h2>Frequently asked questions</h2>
  <div>
    <div class="faq-item">
      <h3>Who are the insiders at ${esc(co.company)}?</h3>
      <p>${
        namedInsiders.length > 0
          ? `Insiders at ${esc(co.company)} who have disclosed transactions include: ${namedInsiders.map(n => esc(n)).join(', ')}. These are PDMRs (Persons Discharging Managerial Responsibilities) who filed with ${ctry.regulator} under MAR Article 19.`
          : `Insider transactions at ${esc(co.company)} are tracked from ${ctry.regulator} filings. InsidersAlpha has recorded ${co.total} total transactions.`
      }</p>
    </div>
    <div class="faq-item">
      <h3>When was the last insider buy at ${esc(co.company)}?</h3>
      <p>${
        latestBuy
          ? `The most recent insider purchase at ${esc(co.company)} was by ${esc(latestBuy.insider_name || 'an insider')} on ${latestBuy.transaction_date}, worth ${formatValue(latestBuy.total_value, cc)}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`
          : `The most recent insider filing at ${esc(co.company)} was recorded on ${co.last || TODAY}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`
      }</p>
    </div>
    <div class="faq-item">
      <h3>Is ${esc(co.company)} stock a buy based on insider activity?</h3>
      <p>InsidersAlpha tracks ${co.total} insider transactions at ${esc(co.company)}. Of these, ${co.buys} are purchases and ${co.sells} are sales (${co.buys + co.sells > 0 ? (co.buys / (co.buys + co.sells) * 100).toFixed(0) : 0}% buy ratio). Insider activity is ${trend}. Past performance does not guarantee future results — always conduct your own research.</p>
    </div>
    <div class="faq-item">
      <h3>Where is ${esc(co.company)} listed?</h3>
      <p>${esc(co.company)} (${esc(co.ticker)}) is listed on ${ctry.exchange} in ${ctry.name}. Insider transactions are disclosed to ${ctry.regulator} under MAR Article 19.</p>
    </div>
  </div>

  <div class="divider"></div>

  <h2>Related pages</h2>
  <div class="link-chips">
    <a href="/market/${ctry.mktSlug}-insider-transactions" class="chip">${ctry.flag} All ${ctry.name} insider transactions</a>
    ${hasCluster    ? '<a href="/signals/cluster-buying" class="chip">🔄 Cluster buying signal</a>' : ''}
    ${hasPriceDip   ? '<a href="/signals/insider-buying-after-price-decline" class="chip">📉 Buying after price decline</a>' : ''}
    ${hasPreEarnings ? '<a href="/signals/pre-earnings-insider-buying" class="chip">📅 Pre-earnings buying</a>' : ''}
    ${hasRepetitive ? '<a href="/signals/repeated-insider-buying" class="chip">🔁 Repeated insider buying</a>' : ''}
    <a href="/signals/high-conviction-insider-buying" class="chip">🔥 High conviction buys</a>
    <a href="/methodology" class="chip">How signals are calculated</a>
    <a href="/best-insider-trading-tracker-europe" class="chip">Best European insider tracker</a>
  </div>
</main>

<footer>
  © ${YEAR} InsidersAlpha &nbsp;·&nbsp;
  <a href="/about">About</a>
  <a href="/methodology">Methodology</a>
  <a href="/disclaimer">Disclaimer</a>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/contact">Contact</a>
</footer>
</body>
</html>`;
}

// ── Sitemap update ────────────────────────────────────────────────────────────

function updateSitemap(companies) {
  let xml = fs.readFileSync(SITEMAP, 'utf8');

  // Remove existing company entries (all <url> blocks containing /company/)
  xml = xml.replace(/<url>\s*<loc>[^<]*\/company\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');

  // Build new company entries
  const newEntries = companies.map(co => {
    const isRecent = (co.last || '') >= CUTOFF_30D;
    return `  <url>
    <loc>${BASE_URL}/company/${co.slug}-insider-transactions</loc>
    <changefreq>weekly</changefreq>
    <priority>${isRecent ? '0.9' : '0.7'}</priority>
    <lastmod>${co.last || TODAY}</lastmod>
  </url>`;
  }).join('\n');

  // Insert before </urlset>
  xml = xml.replace('</urlset>', `${newEntries}\n</urlset>`);

  // Clean up any blank lines left from removal
  xml = xml.replace(/\n{3,}/g, '\n\n');

  fs.writeFileSync(SITEMAP, xml, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Company Page Generator ──────────────────────────────────`);
  console.log(`  Limit:    ${LIMIT} companies`);
  console.log(`  Out dir:  ${OUT_DIR}`);
  console.log(`  Date:     ${TODAY}\n`);

  // 1. Fetch all transactions
  process.stdout.write('  Fetching all transactions… ');
  const allTxns = await fetchAllTransactions();
  console.log(`${allTxns.length} rows`);

  // 2. Determine top companies
  const companies = aggregateCompanies(allTxns, LIMIT);
  console.log(`  Top ${companies.length} companies identified\n`);

  // 3. Assign slugs (detect collisions → add country suffix)
  const slugCounts = {};
  for (const co of companies) {
    const s = makeSlug(co.ticker);
    slugCounts[s] = (slugCounts[s] || 0) + 1;
  }
  for (const co of companies) {
    const s = makeSlug(co.ticker);
    co.slug = slugCounts[s] > 1 ? `${s}-${co.country_code.toLowerCase()}` : s;
  }

  // 4. Group transactions by ticker+country
  const txnMap = new Map();
  for (const t of allTxns) {
    const key = `${t.ticker}|${t.country_code}`;
    if (!txnMap.has(key)) txnMap.set(key, []);
    txnMap.get(key).push(t);
  }

  // 5. Generate pages
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let generated = 0, skipped = 0;

  for (const co of companies) {
    const key  = `${co.ticker}|${co.country_code}`;
    const txns = txnMap.get(key) || [];
    const html = generateHTML(co, txns);
    const file = path.join(OUT_DIR, `${co.slug}-insider-transactions.html`);
    fs.writeFileSync(file, html, 'utf8');
    generated++;
    process.stdout.write(`  ✓ ${co.slug}-insider-transactions.html\n`);
  }

  console.log(`\n  Generated: ${generated} pages`);

  // 6. Update sitemap
  process.stdout.write('  Updating sitemap.xml… ');
  updateSitemap(companies);
  console.log('done');

  console.log(`\n── Done ────────────────────────────────────────────────────\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
