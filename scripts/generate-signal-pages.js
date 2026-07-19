'use strict';
// Generates/refreshes the four signal landing pages with live examples
// pulled from the DB: /signals/ceo-buying, /signals/price-dip-buying,
// /signals/pre-blackout, and (examples-only refresh) /signals/cluster-buying.
//
// Usage: node scripts/generate-signal-pages.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

const OUT_DIR   = path.resolve(__dirname, '../frontend/public/signals');
const BASE_URL  = 'https://www.insidersalpha.com';
const YEAR      = new Date().getFullYear();

const COUNTRY_FLAGS = {
  DE:'🇩🇪',FR:'🇫🇷',GB:'🇬🇧',SE:'🇸🇪',NO:'🇳🇴',DK:'🇩🇰',FI:'🇫🇮',NL:'🇳🇱',
  BE:'🇧🇪',ES:'🇪🇸',IT:'🇮🇹',CH:'🇨🇭',PT:'🇵🇹',LU:'🇱🇺',PL:'🇵🇱',KR:'🇰🇷',
};
const CURRENCY_BY_COUNTRY = {
  DE:'EUR',FR:'EUR',ES:'EUR',BE:'EUR',NL:'EUR',FI:'EUR',PT:'EUR',LU:'EUR',IT:'EUR',
  NO:'NOK',SE:'SEK',DK:'DKK',GB:'GBP',KR:'KRW',PL:'PLN',CH:'CHF',
};
const CURRENCY_SYMBOL = { EUR:'€',GBP:'£',SEK:'SEK ',NOK:'NOK ',DKK:'DKK ',PLN:'PLN ',KRW:'₩',CHF:'CHF ' };

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function currencyOf(row) { return row.currency || CURRENCY_BY_COUNTRY[row.country_code] || 'EUR'; }
function formatValue(val, currency) {
  const v = Math.abs(Number(val || 0));
  const sym = CURRENCY_SYMBOL[currency] || '€';
  if (!v) return '—';
  if (currency === 'KRW') {
    if (v >= 1e12) return `₩${(v/1e12).toFixed(1)}T`;
    if (v >= 1e9)  return `₩${(v/1e9).toFixed(1)}B`;
    if (v >= 1e6)  return `₩${(v/1e6).toFixed(0)}M`;
    return `₩${v.toLocaleString('en')}`;
  }
  if (v >= 1e9) return `${sym}${(v/1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sym}${(v/1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${sym}${(v/1e3).toFixed(1)}K`;
  return `${sym}${v.toFixed(0)}`;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}
function simplifyRole(role) {
  if (!role) return 'Insider';
  const r = role.toLowerCase();
  if (r.includes('chief executive') || r.includes('ceo')) return 'CEO';
  if (r.includes('chief financial') || r.includes('cfo')) return 'CFO';
  if (r.includes('chief operating') || r.includes('coo')) return 'COO';
  if (r.includes('chairman') || r.includes('président') || r.includes('presidente')) return 'Chairman';
  return 'Director';
}

async function fetchExamples(applyFilter, limit = 8) {
  let q = sb.from('insider_transactions')
    .select('company,ticker,country_code,insider_name,insider_role,transaction_date,total_value,currency,price_drawdown,is_cluster_buy')
    .eq('transaction_type', 'BUY')
    .eq('is_unusual_price', false)
    .not('insider_name', 'is', null)
    .neq('insider_name', 'Not disclosed')
    .neq('country_code', 'CH')
    .order('transaction_date', { ascending: false })
    .limit(200); // pull a pool, then filter/rank in JS for flexibility
  q = applyFilter(q);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).slice(0, limit);
}

function exampleRows(rows, extra) {
  return rows.map(t => {
    const flag = COUNTRY_FLAGS[t.country_code] || '';
    const role = simplifyRole(t.insider_role);
    const slug = makeCompanySlug(t.company);
    return `<tr>
          <td>${esc(fmtDate(t.transaction_date))}</td>
          <td>${flag} <a href="/stocks/${slug}-insider-transactions">${esc(t.company)}</a></td>
          <td style="color:#6B7280">${esc(t.insider_name)} (${esc(role)})</td>
          <td style="font-weight:600;font-family:'JetBrains Mono',monospace;font-size:13px">${formatValue(t.total_value, currencyOf(t))}</td>
          ${extra ? `<td>${extra(t)}</td>` : ''}
        </tr>`;
  }).join('\n');
}

const LEGAL_SUFFIXES = ['aktiengesellschaft','gesellschaft mit beschrankter haftung','gesellschaft mbh','naamloze vennootschap','aktiebolag','g\\.m\\.b\\.h\\.','gmbh','s\\.a\\.r\\.l\\.','sarl','s\\.p\\.a\\.','spa','s\\.r\\.l\\.','srl','a\\.s\\.a\\.','asa','s\\.a\\.','a\\.g\\.','n\\.v\\.','b\\.v\\.','s\\.e\\.','p\\.l\\.c\\.','a\\.s\\.','a/s','limited','corporation','oyj','\\bag\\b','\\bnv\\b','\\bbv\\b','\\bse\\b','\\bsa\\b','\\bab\\b','\\bas\\b','\\boy\\b','plc','ltd','inc','corp','llc'];
function makeCompanySlug(company) {
  if (!company) return 'unknown';
  let s = company.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\s+in\s+\S+\s*$/, '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      const re = new RegExp('[\\s,]+(?:' + suf + ')\\s*$', 'i');
      const trimmed = s.replace(re, '').trim();
      if (trimmed !== s) { s = trimmed; changed = true; break; }
    }
  }
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  return s;
}

function pageShell({ slug, badge, emoji, title, metaTitle, metaDesc, lead, howItWorksTitle, howItWorks, methodology, faq, examplesTitle, examplesHeaders, examplesRows, otherSignals }) {
  const canonUrl = `${BASE_URL}/signals/${slug}`;
  const breadcrumbLd = JSON.stringify({
    '@context':'https://schema.org','@type':'BreadcrumbList',
    itemListElement: [
      {'@type':'ListItem',position:1,name:'InsidersAlpha',item:BASE_URL},
      {'@type':'ListItem',position:2,name:'Signals',item:BASE_URL},
      {'@type':'ListItem',position:3,name:title,item:canonUrl},
    ],
  });
  const faqLd = JSON.stringify({
    '@context':'https://schema.org','@type':'FAQPage',
    mainEntity: faq.map(q => ({'@type':'Question',name:q.q,acceptedAnswer:{'@type':'Answer',text:q.a}})),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(metaTitle)}</title>
  <meta name="description" content="${esc(metaDesc)}">
  <meta property="og:title" content="${esc(metaTitle)}">
  <meta property="og:description" content="${esc(metaDesc)}">
  <meta property="og:url" content="${canonUrl}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${canonUrl}">
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
    .wrap{max-width:760px;margin:0 auto;padding:48px 24px 80px}
    .badge{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;background:#f0f0f0;color:#6B7280;border-radius:4px;padding:3px 8px;margin-bottom:20px;font-family:'JetBrains Mono',monospace}
    h1{font-size:30px;font-weight:700;letter-spacing:-.025em;margin-bottom:12px;line-height:1.2}
    h2{font-size:18px;font-weight:700;margin:32px 0 12px}
    h3{font-size:15px;font-weight:600;margin:0 0 6px;color:#111318}
    p{color:#374151;margin-bottom:14px;line-height:1.7}
    .lead{font-size:17px;color:#374151;margin-bottom:28px;line-height:1.7}
    .cta-box{background:#0f1117;border-radius:10px;padding:24px 28px;margin:32px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .cta-box p{color:#9CA3AF;font-size:14px;margin:0}
    .cta-box strong{display:block;color:#fff;font-size:16px;font-weight:700;margin-bottom:4px}
    .cta-btn{display:inline-block;background:#fff;color:#0f1117;border-radius:7px;padding:9px 20px;font-size:13px;font-weight:700;font-family:'Inter',sans-serif;white-space:nowrap}
    .cta-btn:hover{background:#f0f0f0;text-decoration:none}
    .faq-item{border-bottom:1px solid #f0f0f0;padding:16px 0}
    .faq-item:last-child{border-bottom:none}
    .ex-table-wrap{overflow-x:auto;margin-bottom:8px;border:1px solid #f0f0f0;border-radius:9px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa;white-space:nowrap}
    td{padding:10px 12px;border-bottom:1px solid #f6f6f6;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
    .signal-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    .signal-chip{display:inline-flex;align-items:center;gap:6px;background:#f8f8f8;border:1px solid #f0f0f0;border-radius:6px;padding:7px 12px;font-size:13px;font-weight:500;text-decoration:none;color:#374151}
    .signal-chip:hover{background:#f0f0f0;text-decoration:none}
    .divider{height:1px;background:#f0f0f0;margin:28px 0}
    footer{border-top:1px solid #f0f0f0;padding:20px 24px;text-align:center;font-size:12px;color:#9CA3AF}
    footer a{color:#9CA3AF;margin:0 8px}footer a:hover{color:#111318}
    @media(max-width:640px){.wrap{padding:32px 16px 60px}h1{font-size:24px}}
  </style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">
    <svg width="26" height="26" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="200" rx="22" fill="#1a2545"/>
      <rect x="12" y="12" width="176" height="176" rx="14" fill="#ffffff"/>
      <rect x="36" y="12" width="22" height="176" fill="#1a2545"/>
      <path d="M 109 72 L 190 200 L 28 200 Z" fill="#1a2545"/>
      <path d="M 109 113 L 164 200 L 54 200 Z" fill="#ffffff"/>
    </svg>
    InsidersAlpha
  </a>
  <a href="/">← Back to app</a>
</nav>

<main class="wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/">InsidersAlpha</a><span>›</span>
    <a href="/methodology">Signals</a><span>›</span>
    ${esc(title)}
  </nav>

  <div class="badge">Signal</div>
  <h1>${emoji} ${esc(title)}</h1>
  <p class="lead">${lead}</p>

  <div class="cta-box">
    <div>
      <strong>See current ${esc(title)} alerts</strong>
      <p>Live insider transactions with this signal active across 16 markets.</p>
    </div>
    <a href="/" class="cta-btn">View live alerts →</a>
  </div>

  <h2>${howItWorksTitle}</h2>
  ${howItWorks}

  <h2>Detection methodology</h2>
  <p>${methodology}</p>

  ${examplesRows ? `
  <div class="divider"></div>
  <h2>${examplesTitle}</h2>
  <div class="ex-table-wrap">
    <table>
      <thead><tr>${examplesHeaders.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>
        ${examplesRows}
      </tbody>
    </table>
  </div>
  <p style="font-size:11px;color:#9CA3AF;margin-top:6px">Most recent qualifying transactions · <a href="/" style="color:#9CA3AF">View all live in app →</a></p>` : ''}

  <div class="divider"></div>

  <h2>Frequently asked questions</h2>
  <div>
    ${faq.map(q => `<div class="faq-item"><h3>${esc(q.q)}</h3><p>${esc(q.a)}</p></div>`).join('\n    ')}
  </div>

  <div class="divider"></div>

  <h2>Other insider signals</h2>
  <p>InsidersAlpha tracks several distinct insider trading signals. They can fire independently or in combination — co-occurrence of multiple signals on the same transaction is associated with higher conviction.</p>
  <div class="signal-grid">
    ${otherSignals}
  </div>
  <p style="margin-top:16px;font-size:14px">See our <a href="/methodology" style="font-weight:500">methodology page</a> for a full explanation of how all signals are calculated.</p>
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

const ALL_SIGNAL_CHIPS = {
  cluster: '<a href="/signals/cluster-buying" class="signal-chip">🔄 Cluster Buying</a>',
  repeat:  '<a href="/signals/repeated-insider-buying" class="signal-chip">🔁 Repetitive Buying</a>',
  dip:     '<a href="/signals/price-dip-buying" class="signal-chip">📉 Buying After Price Decline</a>',
  blackout:'<a href="/signals/pre-blackout" class="signal-chip">⚠️ Pre-Blackout Buying</a>',
  ceo:     '<a href="/signals/ceo-buying" class="signal-chip">👔 CEO & Executive Buying</a>',
  conviction: '<a href="/signals/high-conviction-insider-buying" class="signal-chip">🔥 High Conviction</a>',
};
function others(...exclude) {
  return Object.entries(ALL_SIGNAL_CHIPS).filter(([k]) => !exclude.includes(k)).map(([,v]) => v).join('\n    ');
}

async function main() {
  console.log('\n── Signal Landing Page Generator ─────────────────────────');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ── CEO & Executive Buying ──────────────────────────────────────────────
  {
    const pool = await fetchExamples(q => q, 300);
    const rows = pool.filter(t => ['CEO','CFO','COO','Chairman'].includes(simplifyRole(t.insider_role))).slice(0, 8);
    const html = pageShell({
      slug: 'ceo-buying',
      title: 'CEO & Executive Insider Buying',
      emoji: '👔',
      metaTitle: 'CEO & Executive Insider Buying Signal | InsidersAlpha',
      metaDesc: 'Track when CEOs, CFOs, COOs and Chairmen buy shares in their own company. Executive purchases carry more weight than board-member trades due to closer access to operational detail.',
      lead: 'CEO and executive buying tracks open-market share purchases made personally by a company\'s CEO, CFO, COO, or Chairman — the roles with the closest, most current view of the business. A director buying is a positive signal; the CEO or CFO buying with personal cash carries more weight.',
      howItWorksTitle: 'Why executive role matters',
      howItWorks: '<p>Not all insiders have equal information. A non-executive director may attend quarterly board meetings; a CEO or CFO lives inside the operating and financial detail of the business every day. When a chief executive or chief financial officer commits personal capital to an open-market purchase, it reflects a judgment made with the fullest possible internal view of the company\'s near-term prospects — which is why InsidersAlpha surfaces C-suite and Chairman purchases as a distinct, higher-weighted category rather than folding them into general insider activity.</p>',
      methodology: 'InsidersAlpha classifies a transaction as CEO/Executive buying when the filed role matches Chief Executive Officer, Chief Financial Officer, Chief Operating Officer, or Chairman (including local-language equivalents such as Président-Directeur Général or Vorstandsvorsitzender). Grants, vestings, and other zero-value or deeply-discounted acquisitions are excluded — only genuine open-market purchases at or near market price count.',
      examplesTitle: 'Recent CEO & executive buys',
      examplesHeaders: ['Date','Company','Executive','Value'],
      examplesRows: exampleRows(rows),
      faq: [
        { q: 'Why do CEO purchases matter more than other insider buys?', a: 'The CEO and CFO have the most complete, current view of a company\'s operations and financial position of any insider. When they commit personal money to an open-market purchase, it reflects a judgment made with fuller information than a non-executive board member typically has.' },
        { q: 'Does this include stock option exercises?', a: 'No. InsidersAlpha excludes grants, vestings, and option exercises at nominal or zero price — only genuine open-market purchases at or near the prevailing market price are counted as executive buying.' },
        { q: 'Which roles count as "executive" on InsidersAlpha?', a: 'CEO, CFO, COO, and Chairman — including local-language equivalents used in French, German, and other European filings. Regular board directors are tracked separately.' },
      ],
      otherSignals: others('ceo'),
    });
    fs.writeFileSync(path.join(OUT_DIR, 'ceo-buying.html'), html, 'utf8');
    console.log(`  ✓ ceo-buying.html (${rows.length} examples)`);
  }

  // ── Price Dip Buying ─────────────────────────────────────────────────────
  {
    const rows = await fetchExamples(q => q.eq('is_price_dip', true), 8);
    const html = pageShell({
      slug: 'price-dip-buying',
      title: 'Insiders Buying After Price Drops',
      emoji: '📉',
      metaTitle: 'Insiders Buying After Price Drops | InsidersAlpha',
      metaDesc: 'Price-dip buying tracks insider purchases made after a 10-60% share price decline — a signal that management sees the drawdown as overdone rather than justified.',
      lead: 'Price-dip buying fires when an insider purchases shares after the stock has already fallen 10–60% from a recent high. Buying into a decline — with personal money, after the bad news is public — is a different, often stronger signal than routine buying at a 52-week high.',
      howItWorksTitle: 'Why buying into weakness is informative',
      howItWorks: '<p>Anyone can buy a stock that\'s going up. Buying after a meaningful decline requires an insider to conclude that the market has overreacted, or that the underlying business is worth more than the current price implies — a judgment made with material non-public context about the actual operating picture, not just the headline that moved the stock.</p>',
      methodology: 'InsidersAlpha flags a purchase as a price-dip buy when the stock has fallen between 10% and 60% from its recent high at the time of the transaction. The 60% cap excludes cases likely caused by stock splits, spin-offs, or delisting-adjacent situations rather than a genuine drawdown. Grants and non-market-price acquisitions are excluded.',
      examplesTitle: 'Recent price-dip buys',
      examplesHeaders: ['Date','Company','Insider','Value'],
      examplesRows: exampleRows(rows),
      faq: [
        { q: 'What counts as a "price dip" for this signal?', a: 'A share price decline of 10% to 60% from a recent high, measured at the time of the insider\'s purchase. Declines beyond 60% are excluded since they are more likely to reflect a stock split, spin-off, or data anomaly than a genuine drawdown.' },
        { q: 'Is buying the dip always a bullish signal?', a: 'It is one input, not a guarantee. A stock can keep falling after an insider buys, and insiders are not always right. It is best read alongside other signals — cluster buying or executive buying after a dip is a stronger combination than a price-dip buy alone.' },
        { q: 'How is the price decline measured?', a: 'Against the stock\'s own recent trading history at the time of the transaction, using daily closing prices. This is calculated automatically for every covered company, not self-reported by the insider.' },
      ],
      otherSignals: others('dip'),
    });
    fs.writeFileSync(path.join(OUT_DIR, 'price-dip-buying.html'), html, 'utf8');
    console.log(`  ✓ price-dip-buying.html (${rows.length} examples)`);
  }

  // ── Pre-Blackout Buying ──────────────────────────────────────────────────
  {
    const rows = await fetchExamples(q => q.eq('is_pre_blackout_buy', true), 8);
    const html = pageShell({
      slug: 'pre-blackout',
      title: 'Pre-Blackout Period Insider Buying',
      emoji: '⚠️',
      metaTitle: 'Pre-Blackout Period Insider Buys | InsidersAlpha',
      metaDesc: 'Pre-blackout buying tracks insider purchases made in the 7-day window just before a MAR closed period begins — the last chance to trade before a ~30-day trading blackout.',
      lead: 'MAR Article 19 bars insiders from trading during a 30-calendar-day closed period before a company publishes interim or annual results. Pre-blackout buying flags purchases made in the final 7 days before that window opens — the last opportunity to act before losing the ability to trade for a month.',
      howItWorksTitle: 'Why timing right before a blackout matters',
      howItWorks: '<p>An insider who buys just before losing the ability to trade for roughly a month is making a deliberate, time-pressured decision. They could have waited, or bought earlier — instead they chose to commit capital in the narrow final window while they still could. That urgency is itself informative, independent of the purchase size.</p>',
      methodology: 'InsidersAlpha estimates each company\'s quarterly closed-period start using the standard MAR pattern (closed periods before Q1, Q2, Q3, and annual results announcements) and flags purchases falling in the 7 calendar days immediately before that estimated start. Because exact reporting calendars vary by company, this is a well-informed estimate rather than a guarantee of the literal closed-period boundary.',
      examplesTitle: 'Recent pre-blackout buys',
      examplesHeaders: ['Date','Company','Insider','Value'],
      examplesRows: exampleRows(rows),
      faq: [
        { q: 'What is a MAR closed period?', a: 'A 30-calendar-day window before a company announces interim or annual financial results, during which PDMRs are generally barred from trading in the company\'s shares under MAR Article 19.' },
        { q: 'Why track buying right before a blackout instead of during it?', a: 'Trading during the closed period itself is generally prohibited, so there is little to track. The signal is about the days just before it starts — insiders choosing to act while they still can, rather than waiting.' },
        { q: 'Is this the same as the old "pre-earnings buying" signal?', a: 'This replaces it. The earlier version estimated buying ahead of earnings announcements specifically; the current signal is calculated directly from MAR\'s actual closed-period mechanic, which is a more precise and better-grounded basis for the same idea.' },
      ],
      otherSignals: others('blackout'),
    });
    fs.writeFileSync(path.join(OUT_DIR, 'pre-blackout.html'), html, 'utf8');
    console.log(`  ✓ pre-blackout.html (${rows.length} examples)`);
  }

  // ── Cluster Buying: refresh live examples in the existing page ──────────
  {
    const rows = await fetchExamples(q => q.eq('is_cluster_buy', true), 8);
    const examplesBlock = `
  <div class="divider"></div>
  <h2>Recent cluster buys</h2>
  <div class="ex-table-wrap" style="overflow-x:auto;margin-bottom:8px;border:1px solid #f0f0f0;border-radius:9px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr><th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa">Date</th><th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa">Company</th><th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa">Insider</th><th style="text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa">Value</th></tr></thead>
      <tbody>
        ${exampleRows(rows).replace(/<td>/g, '<td style="padding:10px 12px;border-bottom:1px solid #f6f6f6">')}
      </tbody>
    </table>
  </div>
  <p style="font-size:11px;color:#9CA3AF;margin-top:6px">Most recent qualifying transactions · <a href="/" style="color:#9CA3AF">View all live in app →</a></p>
`;
    const fp = path.join(OUT_DIR, 'cluster-buying.html');
    let html = fs.readFileSync(fp, 'utf8');
    const marker = '<h2>Frequently asked questions</h2>';
    if (html.includes('<h2>Recent cluster buys</h2>')) {
      html = html.replace(/\n  <div class="divider"><\/div>\n  <h2>Recent cluster buys<\/h2>[\s\S]*?<\/p>\n(\n  <div class="divider"><\/div>\n  <h2>Frequently asked questions<\/h2>)/, `$1`);
    }
    html = html.replace(marker, `${examplesBlock.trim()}\n\n  <div class="divider"></div>\n\n  ${marker}`);
    fs.writeFileSync(fp, html, 'utf8');
    console.log(`  ✓ cluster-buying.html refreshed with ${rows.length} live examples`);
  }

  console.log('\n── Done ──────────────────────────────────────────────────\n');
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
