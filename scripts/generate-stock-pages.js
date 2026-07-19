'use strict';
// Generates / refreshes SEO stock pages at /stocks/{slug}-insider-transactions
// Usage:  node scripts/generate-stock-pages.js [--limit N]
// Cron:   0 8 * * 0  cd /opt/insider-tracker && node scripts/generate-stock-pages.js

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const LIMIT      = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i+1]) : 150; })();
const OUT_DIR    = path.resolve(__dirname, '../frontend/public/stocks');
const SITEMAP    = path.resolve(__dirname, '../frontend/public/sitemap.xml');
const VERCEL_JSON = path.resolve(__dirname, '../frontend/vercel.json');
const BASE_URL   = 'https://www.insidersalpha.com';
const YEAR       = new Date().getFullYear();
const TODAY      = new Date().toISOString().slice(0, 10);
const CUTOFF_30D  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const CUTOFF_90D  = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
const CUTOFF_6MO  = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

// ── Priority companies (must include even if < 3 tx) ────────────────────────
// Match by partial company name (case-insensitive) + country_code
const PRIORITY = [
  { nameMatch: 'samsung electronics',  cc: 'KR' },
  { nameMatch: 'sk hynix',             cc: 'KR' },
  { nameMatch: 'novo nordisk',          cc: 'DK' },
  { nameMatch: 'sap',                   cc: 'DE' },
  { nameMatch: 'lvmh',                  cc: 'FR' },
  { nameMatch: 'hermès',               cc: 'FR' },
  { nameMatch: 'hermes',               cc: 'FR' },
  { nameMatch: 'siemens',              cc: 'DE' },
  { nameMatch: 'adyen',                cc: 'NL' },
  { nameMatch: 'rheinmetall',          cc: 'DE' },
  // Volvo Car AB (VOLCAR-B) is a separate, distinct company from AB Volvo
  // (VOLV-B) — force-included since it currently has <3 transactions on
  // record (its ticker was mis-scraped as VOLV-B until this fix, so it was
  // previously silently merged into AB Volvo's page instead of having its own).
  { nameMatch: 'volvo car',            cc: 'SE' },
  // Luxembourg
  { nameMatch: 'grand city properties', cc: 'LU' },
  { nameMatch: 'eurofins',             cc: 'LU' },
  { nameMatch: 'arcelormittal',        cc: 'LU' },
  { nameMatch: 'aperam',               cc: 'LU' },
  { nameMatch: 'inpost',               cc: 'LU' },
  { nameMatch: 'brederode',            cc: 'LU' },
];

// ── Country metadata ──────────────────────────────────────────────────────────

const COUNTRY = {
  IT: { name: 'Italy',          flag: '🇮🇹', exchange: 'Euronext Milan',         regulator: 'Consob',             mktSlug: 'italy' },
  FR: { name: 'France',         flag: '🇫🇷', exchange: 'Euronext Paris',         regulator: 'AMF',                mktSlug: 'france' },
  DE: { name: 'Germany',        flag: '🇩🇪', exchange: 'Frankfurt Stock Exchange', regulator: 'BaFin',             mktSlug: 'germany' },
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
  PL: { name: 'Poland',         flag: '🇵🇱', exchange: 'Warsaw Stock Exchange',  regulator: 'GPW/KNF',            mktSlug: 'poland' },
  KR: { name: 'South Korea',    flag: '🇰🇷', exchange: 'Korea Exchange',         regulator: 'FSC/FSS',            mktSlug: 'south-korea' },
};

const CURRENCY = {
  IT:'EUR', FR:'EUR', DE:'EUR', ES:'EUR', BE:'EUR',
  NL:'EUR', FI:'EUR', PT:'EUR', LU:'EUR',
  NO:'NOK', SE:'SEK', DK:'DKK', CH:'CHF', GB:'GBP', KR:'KRW', PL:'PLN',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatValue(val, cc) {
  const v = Math.abs(Number(val || 0));
  if (!v) return '—';
  const cur = CURRENCY[cc] || 'EUR';
  const sym = { EUR:'€', GBP:'£', CHF:'CHF ', SEK:'SEK ', NOK:'NOK ', DKK:'DKK ', KRW:'₩', PLN:'PLN ' }[cur] || '';
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

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr + 'T12:00:00Z').getTime();
  const d = Math.floor(ms / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7)  return `${d} days ago`;
  if (d < 30) return `${Math.round(d/7)} week${Math.round(d/7) !== 1 ? 's' : ''} ago`;
  return `${Math.round(d/30)} month${Math.round(d/30) !== 1 ? 's' : ''} ago`;
}

function buyTrend(buys, sells, buys6mo, buyVal6mo) {
  const total = buys + sells;
  if (total === 0) return 'mixed';
  const r = buys / total;
  if (r >= 0.75) return `strongly bullish — insiders have made ${buys} purchases vs ${sells} sales`;
  if (r >= 0.5)  return `moderately bullish — more buying than selling (${buys} buys vs ${sells} sells)`;
  if (r <= 0.25) return `bearish — insiders are predominantly selling (${buys} buys vs ${sells} sells)`;
  return `mixed — showing both buying and selling (${buys} buys vs ${sells} sells)`;
}

// Ordered longest-first so compound words match before fragments
const LEGAL_SUFFIXES = [
  'aktiengesellschaft', 'gesellschaft mit beschrankter haftung', 'gesellschaft mbh',
  'naamloze vennootschap', 'aktiebolag',
  'g\\.m\\.b\\.h\\.', 'gmbh',
  's\\.a\\.r\\.l\\.', 'sarl',
  's\\.p\\.a\\.', 'spa',
  's\\.r\\.l\\.', 'srl',
  'a\\.s\\.a\\.', 'asa',
  's\\.a\\.', 'a\\.g\\.', 'n\\.v\\.', 'b\\.v\\.', 's\\.e\\.', 'p\\.l\\.c\\.',
  'a\\.s\\.', 'a/s',
  'limited', 'corporation', 'oyj',
  '\\bag\\b', '\\bnv\\b', '\\bbv\\b', '\\bse\\b', '\\bsa\\b', '\\bab\\b',
  '\\bas\\b', '\\boy\\b', 'plc', 'ltd', 'inc', 'corp', 'llc',
];

function makeSlugFromName(company) {
  if (!company) return 'unknown';
  let s = company.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Strip trailing location phrases like " in Munchen"
  s = s.replace(/\s+in\s+\S+\s*$/, '').trim();
  // Repeatedly strip legal suffixes from end
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      const re = new RegExp('[\\s,]+(?:' + suf + ')\\s*$', 'i');
      const trimmed = s.replace(re, '').trim();
      if (trimmed !== s) { s = trimmed; changed = true; break; }
    }
  }
  // Convert non-alphanumeric to hyphens
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Cap slug length at 60 chars, trim trailing hyphens
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  return s;
}

// ── Fetch all transactions (single pass) ─────────────────────────────────────

async function fetchAllTransactions() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_transactions')
      .select('id,company,ticker,country_code,transaction_type,transaction_date,insider_name,via_entity,insider_role,shares,price_per_share,total_value,is_cluster_buy,is_price_dip,is_pre_earnings,is_repetitive_buy,conviction_label')
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

// ── Aggregate companies ───────────────────────────────────────────────────────

function aggregateCompanies(rows, limit) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!map.has(key)) {
      map.set(key, { company: r.company, ticker: r.ticker, country_code: r.country_code,
        total: 0, buys: 0, sells: 0, last: '', earliest: '', totalVal: 0, buyVal: 0,
        buys6mo: 0, buyVal6mo: 0 });
    }
    const g = map.get(key);
    g.total++;
    const tp = (r.transaction_type || '').toUpperCase();
    const isBuy = tp === 'BUY' || tp === 'PURCHASE';
    const isSell = tp === 'SELL' || tp === 'SALE';
    if (isBuy)  { g.buys++;  g.buyVal += Number(r.total_value || 0); }
    if (isSell) g.sells++;
    if ((r.transaction_date || '') > g.last) g.last = r.transaction_date;
    if (!g.earliest || (r.transaction_date || '') < g.earliest) g.earliest = r.transaction_date;
    g.totalVal += Math.abs(Number(r.total_value || 0));
    if (isBuy && (r.transaction_date || '') >= CUTOFF_6MO) {
      g.buys6mo++;
      g.buyVal6mo += Number(r.total_value || 0);
    }
  }

  const all = [...map.values()];

  // Mark priority companies so they're always included
  for (const co of all) {
    const nameLower = (co.company || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    co.isPriority = PRIORITY.some(p => {
      const pLower = p.nameMatch.normalize('NFD').replace(/[̀-ͯ]/g,'');
      return nameLower.includes(pLower) && co.country_code === p.cc;
    });
  }

  const priorities = all.filter(c => c.isPriority);
  // New markets get all companies included regardless of transaction count
  const NEW_MARKETS = new Set(['PL']);
  const rest = all
    .filter(c => !c.isPriority && (c.total >= 3 || NEW_MARKETS.has(c.country_code)))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  // Merge: priorities first, then rest (deduplicated)
  const merged = [...priorities];
  const seen = new Set(priorities.map(c => `${c.ticker}|${c.country_code}`));
  for (const c of rest) {
    const k = `${c.ticker}|${c.country_code}`;
    if (!seen.has(k)) { merged.push(c); seen.add(k); }
  }

  return merged;
}

// ── HTML generator ────────────────────────────────────────────────────────────

function generateHTML(co, txns) {
  const cc    = co.country_code;
  const ctry  = COUNTRY[cc] || { name: cc, flag: '', exchange: cc, regulator: cc, mktSlug: cc.toLowerCase() };

  const sorted   = [...txns].sort((a, b) => (b.transaction_date || '').localeCompare(a.transaction_date || ''));
  const recent5  = sorted.slice(0, 5);
  const latestBuy = sorted.find(t => { const tp=(t.transaction_type||'').toUpperCase(); return tp==='BUY'||tp==='PURCHASE'; });
  const largest   = txns.reduce((best, t) => Math.abs(Number(t.total_value||0)) > Math.abs(Number(best?.total_value||0)) ? t : best, null);

  // Named insiders with transaction counts
  const insiderMap = new Map();
  for (const t of sorted) {
    if (!t.insider_name || t.insider_name === 'Not disclosed') continue;
    if (!insiderMap.has(t.insider_name)) {
      insiderMap.set(t.insider_name, { name: t.insider_name, role: t.insider_role || '', total: 0, buys: 0 });
    }
    const ins = insiderMap.get(t.insider_name);
    ins.total++;
    const tp = (t.transaction_type || '').toUpperCase();
    if (tp === 'BUY' || tp === 'PURCHASE') ins.buys++;
  }
  const namedInsiders = [...insiderMap.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Signals in last 90d
  const recent90 = txns.filter(t => (t.transaction_date || '') >= CUTOFF_90D);
  const hasCluster     = recent90.some(t => t.is_cluster_buy);
  const hasPriceDip    = recent90.some(t => t.is_price_dip);
  const hasPreEarnings = recent90.some(t => t.is_pre_earnings);
  const hasRepetitive  = recent90.some(t => t.is_repetitive_buy);
  const cluster14d     = txns.filter(t => t.is_cluster_buy && (t.transaction_date||'') >= new Date(Date.now()-14*86400000).toISOString().slice(0,10));

  const trend = buyTrend(co.buys, co.sells, co.buys6mo, co.buyVal6mo);
  const ratio = co.buys + co.sells > 0 ? (co.buys / (co.buys + co.sells) * 100).toFixed(0) : 0;
  const lastAgo = daysAgo(co.last);
  const canonUrl = `${BASE_URL}/stocks/${co.slug}-insider-transactions`;

  const metaDesc = latestBuy
    ? `Track insider buying at ${co.company} (${co.ticker}). ${co.total} transactions tracked since ${co.earliest || '—'}. Latest: ${(latestBuy.insider_name || 'An insider').slice(0,40)} ${latestBuy.transaction_type === 'SELL' || latestBuy.transaction_type === 'SALE' ? 'sold' : 'bought'} ${formatValue(latestBuy.total_value, cc)} on ${latestBuy.transaction_date}. Official MAR Art.19 data.`
    : `Track insider buying and selling at ${co.company} (${co.ticker}). ${co.total} transactions tracked since ${co.earliest || '—'}. Real-time MAR Art.19 disclosures from ${ctry.regulator}.`;

  // GEO-optimized opening paragraph: states the actual latest transaction as
  // a fact (who, what, when, how much) rather than a generic "track insider
  // activity" line — easier for an LLM or search snippet to extract and
  // quote directly.
  const latestMonthYear = latestBuy
    ? new Date(latestBuy.transaction_date + 'T12:00:00Z').toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : null;
  const introParagraph = latestBuy
    ? `The most recent insider transactions at ${esc(co.company)} include purchases filed with ${ctry.regulator} under MAR Article 19. In ${latestMonthYear}, ${esc(latestBuy.insider_name || 'an insider')}${latestBuy.insider_role ? ` (${esc(latestBuy.insider_role)})` : ''} bought ${latestBuy.shares ? Number(latestBuy.shares).toLocaleString('en') + ' shares' : 'shares'} worth ${formatValue(latestBuy.total_value, cc)}.`
    : `Insider transactions at ${esc(co.company)} are filed with ${ctry.regulator} under MAR Article 19. InsidersAlpha tracks ${co.total} transaction${co.total!==1?'s':''} on record from official regulatory disclosures.`;

  // Recent transactions rows
  const recentRows = recent5.map(t => {
    const tp    = (t.transaction_type || '').toUpperCase();
    const isBuy = tp === 'BUY' || tp === 'PURCHASE';
    const insName = t.insider_name || (t.via_entity ? `Via ${t.via_entity}` : 'Undisclosed');
    const insSlug = t.insider_name
      ? t.insider_name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
      : null;
    const badges = [
      t.is_cluster_buy    ? '<span title="Cluster buy">🔄</span>'    : '',
      t.is_price_dip      ? '<span title="Price dip buy">📉</span>'  : '',
      t.is_pre_earnings   ? '<span title="Pre-earnings buy">📅</span>' : '',
      t.is_repetitive_buy ? '<span title="Repeat buyer">🔁</span>'   : '',
    ].filter(Boolean).join(' ');
    return `<tr>
          <td>${esc(t.transaction_date || '—')}</td>
          <td class="truncate" title="${esc(insName)}">${insSlug ? `<a href="/insider/${insSlug}-insider-trading" style="color:#111318;text-decoration:none">${esc(insName.slice(0,28))}</a>` : esc(insName.slice(0,28))}</td>
          <td class="role-cell truncate" style="color:#6B7280">${esc((t.insider_role || '').slice(0,24))}</td>
          <td><span class="${isBuy ? 'type-buy' : 'type-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${t.shares ? Number(t.shares).toLocaleString('en') : '—'}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${t.price_per_share ? formatValue(t.price_per_share, cc) : '—'}</td>
          <td style="font-weight:600;font-family:'JetBrains Mono',monospace;font-size:12px">${formatValue(t.total_value, cc)}</td>
          <td style="white-space:nowrap">${badges || '<span style="color:#d1d5db">—</span>'}</td>
        </tr>`;
  }).join('\n');

  // Key insiders list
  const insiderRows = namedInsiders.map(ins => {
    const initials = ins.name.split(' ').map(n=>n[0]).filter(Boolean).join('').slice(0,2).toUpperCase();
    const slug = ins.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    return `<div class="insider-row">
          <div class="insider-avatar">${esc(initials)}</div>
          <div class="insider-info" style="flex:1">
            <div class="insider-name">${esc(ins.name)}</div>
            ${ins.role ? `<div class="insider-role">${esc(ins.role)}</div>` : ''}
            <div class="insider-stats">${ins.total} filing${ins.total!==1?'s':''} · ${ins.buys} buy${ins.buys!==1?'s':''}</div>
          </div>
          <a href="/insider/${slug}-insider-trading" class="view-link">View profile →</a>
        </div>`;
  }).join('\n');

  // Signal badges
  const sigBadges = [
    hasCluster     && `<span class="sig sig-cluster">🔄 Cluster buying${cluster14d.length ? ` (${cluster14d.length} insiders, last 14 days)` : ''}</span>`,
    hasPriceDip    && '<span class="sig sig-dip">📉 Bought after price decline</span>',
    hasPreEarnings && '<span class="sig sig-earnings">📅 Pre-earnings buying activity</span>',
    hasRepetitive  && '<span class="sig sig-repeat">🔁 Repeat buyer activity</span>',
  ].filter(Boolean).join('\n        ');

  // JSON-LD: breadcrumb
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'InsidersAlpha', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: 'Markets', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 3, name: `${ctry.name} Insider Transactions`, item: `${BASE_URL}/market/${ctry.mktSlug}-insider-transactions` },
      { '@type': 'ListItem', position: 4, name: co.company, item: canonUrl },
    ],
  });

  // JSON-LD: FAQ (real data)
  const namedList = namedInsiders.slice(0, 3).map(ins => `${ins.name}${ins.role ? ` (${ins.role})` : ''}`).join(', ');
  const faqLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `Who are the insiders trading ${co.company} stock?`,
        acceptedAnswer: { '@type': 'Answer', text:
          namedInsiders.length > 0
            ? `Known insiders at ${co.company} include ${namedList}. InsidersAlpha tracks ${namedInsiders.length} named insider${namedInsiders.length!==1?'s':''} at ${co.company}.`
            : `Insider transactions at ${co.company} are filed with ${ctry.regulator} under MAR Article 19. InsidersAlpha has recorded ${co.total} total transactions.`,
        },
      },
      {
        '@type': 'Question',
        name: `When was the last insider buy at ${co.company}?`,
        acceptedAnswer: { '@type': 'Answer', text:
          latestBuy
            ? `The most recent insider purchase at ${co.company} was by ${latestBuy.insider_name || 'an insider'}${latestBuy.insider_role ? ` (${latestBuy.insider_role})` : ''} on ${latestBuy.transaction_date}, buying ${latestBuy.shares ? Number(latestBuy.shares).toLocaleString('en') + ' shares' : ''} at ${latestBuy.price_per_share ? formatValue(latestBuy.price_per_share, cc) : '—'} for a total of ${formatValue(latestBuy.total_value, cc)}.`
            : `The most recent insider filing at ${co.company} was on ${co.last || TODAY}. InsidersAlpha updates daily from ${ctry.regulator}.`,
        },
      },
      {
        '@type': 'Question',
        name: `How many insider transactions has ${co.company} had?`,
        acceptedAnswer: { '@type': 'Answer', text:
          `${co.company} has had ${co.total} insider transactions tracked on InsidersAlpha, including ${co.buys} purchase${co.buys!==1?'s':''} and ${co.sells} sale${co.sells!==1?'s':''}.`,
        },
      },
      {
        '@type': 'Question',
        name: `What is the insider buying trend at ${co.company}?`,
        acceptedAnswer: { '@type': 'Answer', text:
          `Over the past 6 months, ${co.company} insiders have made ${co.buys6mo} purchase${co.buys6mo!==1?'s':''} totaling ${formatValue(co.buyVal6mo, cc)}. The overall buy/sell ratio is ${ratio}% buys (${co.buys} purchases vs ${co.sells} sales).`,
        },
      },
    ],
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(co.company)} Insider Transactions ${YEAR} - Directors Dealings | InsidersAlpha</title>
  <meta name="description" content="${esc(metaDesc)}">
  <meta property="og:title" content="${esc(co.company)} (${esc(co.ticker)}) Insider Transactions | InsidersAlpha">
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
    .breadcrumb{font-size:12px;color:#9CA3AF;margin-bottom:20px;line-height:1.8}
    .breadcrumb a{color:#9CA3AF}.breadcrumb a:hover{color:#111318}
    .breadcrumb span{margin:0 5px}
    .wrap{max-width:820px;margin:0 auto;padding:48px 24px 80px}
    h1{font-size:28px;font-weight:700;letter-spacing:-.025em;margin-bottom:8px;line-height:1.2}
    h2{font-size:17px;font-weight:700;margin:32px 0 12px;letter-spacing:-.01em}
    h3{font-size:14px;font-weight:600;margin:0 0 6px;color:#111318}
    p{color:#374151;margin-bottom:14px;line-height:1.75}
    .hero-sub{font-size:15px;color:#6B7280;margin-bottom:4px}
    .updated-note{font-size:11px;color:#9CA3AF;margin-bottom:24px}
    .header-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px;flex-wrap:wrap}
    .header-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
    .hbadge{background:#f8f8f8;border:1px solid #f0f0f0;border-radius:6px;padding:4px 10px;font-size:12px;color:#6B7280;display:inline-flex;align-items:center;gap:5px}
    .hbadge strong{color:#111318;font-weight:600}
    .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px}
    @media(max-width:560px){.stats-grid{grid-template-columns:1fr 1fr}}
    .stat-card{border:1px solid #f0f0f0;border-radius:9px;padding:14px 16px;text-align:center;background:#fafafa}
    .stat-card .val{font-size:22px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-.02em;margin-bottom:2px}
    .stat-card .val.sm{font-size:14px}
    .stat-card .lbl{font-size:10px;color:#9CA3AF;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
    .signal-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:24px}
    .sig{display:inline-block;border-radius:6px;padding:5px 11px;font-size:12px;font-weight:600}
    .sig-cluster{background:#EEF2FF;color:#4338CA}
    .sig-dip{background:#FEF9C3;color:#854D0E}
    .sig-earnings{background:#FFF7ED;color:#C2410C}
    .sig-repeat{background:#F5F3FF;color:#7C3AED}
    .cta-box{background:#0f1117;border-radius:10px;padding:22px 28px;margin:28px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .cta-box p{color:#9CA3AF;font-size:13px;margin:0}
    .cta-box strong{display:block;color:#fff;font-size:15px;font-weight:700;margin-bottom:3px}
    .cta-btn{display:inline-block;background:#fff;color:#0f1117;border-radius:7px;padding:9px 20px;font-size:13px;font-weight:700;white-space:nowrap}
    .cta-btn:hover{background:#f0f0f0;text-decoration:none}
    .txn-table-wrap{overflow-x:auto;margin-bottom:4px;border:1px solid #f0f0f0;border-radius:9px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa;white-space:nowrap}
    th:first-child{border-radius:9px 0 0 0}th:last-child{border-radius:0 9px 0 0}
    td{padding:10px 12px;border-bottom:1px solid #f6f6f6;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
    .type-buy{background:#DCFCE7;color:#15803D;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;font-family:'JetBrains Mono',monospace}
    .type-sell{background:#FEE2E2;color:#DC2626;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;font-family:'JetBrains Mono',monospace}
    .truncate{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .role-cell{color:#9CA3AF}
    .insider-list{display:flex;flex-direction:column;gap:8px;margin-bottom:24px}
    .insider-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #f0f0f0;border-radius:9px;background:#fafafa}
    .insider-row:hover{background:#f3f4f6}
    .insider-avatar{width:38px;height:38px;border-radius:50%;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#374151;flex-shrink:0;font-family:'JetBrains Mono',monospace}
    .insider-name{font-weight:600;font-size:13px;color:#111318}
    .insider-role{font-size:12px;color:#6B7280;margin-top:1px}
    .insider-stats{font-size:11px;color:#9CA3AF;margin-top:3px}
    .view-link{font-size:12px;color:#6B7280;white-space:nowrap;flex-shrink:0}.view-link:hover{color:#111318}
    .faq-item{border-bottom:1px solid #f0f0f0;padding:16px 0}
    .faq-item:last-child{border-bottom:none}
    .link-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
    .chip{display:inline-block;background:#f8f8f8;border:1px solid #f0f0f0;border-radius:6px;padding:5px 13px;font-size:13px;color:#374151}
    .chip:hover{background:#f0f0f0;text-decoration:none}
    .divider{height:1px;background:#f0f0f0;margin:32px 0}
    .about-data{background:#f9fafb;border:1px solid #f0f0f0;border-radius:9px;padding:18px 20px;margin-bottom:24px}
    .about-data p{margin:0;font-size:13px;color:#374151;line-height:1.7}
    footer{border-top:1px solid #f0f0f0;padding:20px 24px;text-align:center;font-size:12px;color:#9CA3AF}
    footer a{color:#9CA3AF;margin:0 8px}footer a:hover{color:#111318}
    @media(max-width:640px){.role-cell{display:none}th:nth-child(5),td:nth-child(5){display:none}.wrap{padding:32px 16px 60px}h1{font-size:22px}}
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
    <a href="/market/${ctry.mktSlug}-insider-transactions">${ctry.flag} ${ctry.name} Insider Transactions</a><span>›</span>
    ${esc(co.company)}
  </nav>

  <div class="header-row">
    <h1>${esc(co.company)} (${esc(co.ticker)}) Insider Transactions</h1>
  </div>
  <div class="header-badges">
    <span class="hbadge">${ctry.flag} <strong>${ctry.name}</strong></span>
    <span class="hbadge">🏛 <strong>${ctry.exchange}</strong></span>
    <span class="hbadge">📋 <strong>${ctry.regulator}</strong></span>
    <span class="hbadge">🔄 Updated daily</span>
    ${(co.last || '') >= CUTOFF_30D ? '<span class="hbadge" style="background:#DCFCE7;border-color:#BBF7D0;color:#15803D">🟢 <strong>Recently active</strong></span>' : ''}
  </div>
  <p class="hero-sub">${introParagraph}</p>
  <p class="updated-note">Last updated: ${TODAY} · Data sourced from MAR Article 19 regulatory disclosures</p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="val">${co.total}</div>
      <div class="lbl">Total Transactions</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#15803D">${co.buys}</div>
      <div class="lbl">Insider Buys</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#DC2626">${co.sells}</div>
      <div class="lbl">Insider Sells</div>
    </div>
    <div class="stat-card">
      <div class="val sm">${lastAgo || co.last || '—'}</div>
      <div class="lbl">Last Activity</div>
    </div>
  </div>

  ${sigBadges ? `<div class="signal-row">\n        ${sigBadges}\n      </div>` : ''}

  ${recent5.length > 0 ? `
  <h2>Recent Insider Transactions at ${esc(co.company)}</h2>
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
  </div>
  <p style="font-size:11px;color:#9CA3AF;margin-top:6px">Showing last ${recent5.length} transactions · <a href="/" style="color:#9CA3AF">View all in app →</a></p>` : ''}

  <div class="cta-box">
    <div>
      <strong>See all ${esc(co.company)} insider transactions in real-time</strong>
      <p>Live filings with conviction scores, signal badges, and post-trade return tracking.</p>
    </div>
    <a href="/" class="cta-btn">View Live Data →</a>
  </div>

  ${namedInsiders.length > 0 ? `
  <h2>Insiders Tracked at ${esc(co.company)}</h2>
  <div class="insider-list">
    ${insiderRows}
  </div>` : ''}

  ${sigBadges ? `
  <div class="divider"></div>
  <h2>Signal Activity at ${esc(co.company)}</h2>
  <div class="signal-row">
    ${sigBadges}
  </div>
  <p style="font-size:13px;color:#6B7280">Signal badges are detected automatically from filing patterns. <a href="/methodology" style="color:#6B7280">Learn how signals are calculated →</a></p>` : ''}

  <div class="divider"></div>

  <h2>About This Data</h2>
  <div class="about-data">
    <p>InsidersAlpha tracks insider transactions at ${esc(co.company)} filed with ${ctry.regulator} under MAR Article 19. Data is sourced directly from official regulatory filings and updated daily. All ${co.total} transactions on record include ${co.buys} insider purchase${co.buys!==1?'s':''} and ${co.sells} sale${co.sells!==1?'s':''}.</p>
    ${largest && Number(largest.total_value) > 0 ? `<p style="margin-top:8px">The largest single transaction recorded was worth ${formatValue(largest.total_value, cc)}${largest.insider_name ? ` by ${esc(largest.insider_name)}` : ''} on ${largest.transaction_date}.</p>` : ''}
  </div>

  <div class="divider"></div>

  <h2>Frequently Asked Questions</h2>
  <div>
    <div class="faq-item">
      <h3>Who are the insiders trading ${esc(co.company)} stock?</h3>
      <p>${
        namedInsiders.length > 0
          ? `Known insiders at ${esc(co.company)} include ${namedInsiders.map(ins => `${esc(ins.name)}${ins.role ? ` (${esc(ins.role)})` : ''}`).join(', ')}. InsidersAlpha tracks ${namedInsiders.length} named insider${namedInsiders.length!==1?'s':''} at ${esc(co.company)}.`
          : `Insider transactions at ${esc(co.company)} are tracked from ${ctry.regulator} filings. InsidersAlpha has recorded ${co.total} total transactions.`
      }</p>
    </div>
    <div class="faq-item">
      <h3>When was the last insider buy at ${esc(co.company)}?</h3>
      <p>${
        latestBuy
          ? `The most recent insider purchase at ${esc(co.company)} was by ${esc(latestBuy.insider_name || 'an insider')}${latestBuy.insider_role ? ` (${esc(latestBuy.insider_role)})` : ''} on ${latestBuy.transaction_date}, buying ${latestBuy.shares ? Number(latestBuy.shares).toLocaleString('en') + ' shares' : 'shares'} at ${latestBuy.price_per_share ? formatValue(latestBuy.price_per_share, cc) : '—'} for a total of ${formatValue(latestBuy.total_value, cc)}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`
          : `The most recent insider filing at ${esc(co.company)} was recorded on ${co.last || TODAY}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`
      }</p>
    </div>
    <div class="faq-item">
      <h3>How many insider transactions has ${esc(co.company)} had?</h3>
      <p>${esc(co.company)} has had ${co.total} insider transactions tracked on InsidersAlpha, including ${co.buys} purchase${co.buys!==1?'s':''} and ${co.sells} sale${co.sells!==1?'s':''}. The overall buy/sell ratio is ${ratio}% buys.</p>
    </div>
    <div class="faq-item">
      <h3>What is the insider buying trend at ${esc(co.company)}?</h3>
      <p>Over the past 6 months, ${esc(co.company)} insiders have made ${co.buys6mo} purchase${co.buys6mo!==1?'s':''} totaling ${formatValue(co.buyVal6mo, cc)}. The insider activity trend is ${trend}. Past performance does not guarantee future results — always conduct your own research.</p>
    </div>
  </div>

  <div class="divider"></div>

  <h2>Related Pages</h2>
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

  // Remove existing /stocks/ entries
  xml = xml.replace(/<url>\s*<loc>[^<]*\/stocks\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');

  const CUTOFF_90D_PRIO = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const newEntries = companies.map(co => {
    const last = co.last || TODAY;
    let priority = '0.5';
    if (last >= CUTOFF_30D)       priority = '0.9';
    else if (last >= CUTOFF_90D_PRIO) priority = '0.7';
    return `  <url>
    <loc>${BASE_URL}/stocks/${co.slug}-insider-transactions</loc>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
    <lastmod>${last}</lastmod>
  </url>`;
  }).join('\n');

  xml = xml.replace('</urlset>', `${newEntries}\n</urlset>`);
  xml = xml.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(SITEMAP, xml, 'utf8');
}

// ── vercel.json update ────────────────────────────────────────────────────────

function updateVercelJson() {
  const vj = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  const stocksRewrite = { source: '/stocks/:slug', destination: '/stocks/:slug.html' };

  // Check if already present
  const alreadyHas = vj.rewrites.some(r => r.source === '/stocks/:slug');
  if (!alreadyHas) {
    // Insert before the catch-all SPA rewrite (last entry)
    const catchAll = vj.rewrites.findIndex(r => r.source === '/((?!api/).*)');
    if (catchAll >= 0) {
      vj.rewrites.splice(catchAll, 0, stocksRewrite);
    } else {
      vj.rewrites.push(stocksRewrite);
    }
    fs.writeFileSync(VERCEL_JSON, JSON.stringify(vj, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Stock Page Generator ──────────────────────────────────`);
  console.log(`  Limit:    ${LIMIT} companies (+ priority companies)`);
  console.log(`  Out dir:  ${OUT_DIR}`);
  console.log(`  Date:     ${TODAY}\n`);

  process.stdout.write('  Fetching all transactions… ');
  const allTxns = await fetchAllTransactions();
  console.log(`${allTxns.length} rows`);

  const companies = aggregateCompanies(allTxns, LIMIT);
  console.log(`  ${companies.length} companies identified (${companies.filter(c=>c.isPriority).length} priority)\n`);

  // Assign slugs from company name with collision detection
  const slugCounts = {};
  for (const co of companies) {
    const s = makeSlugFromName(co.company);
    slugCounts[s] = (slugCounts[s] || 0) + 1;
  }
  const slugAssigned = {};
  for (const co of companies) {
    const s = makeSlugFromName(co.company);
    if (slugCounts[s] > 1) {
      // Disambiguate: append country code
      const candidate = `${s}-${co.country_code.toLowerCase()}`;
      co.slug = candidate;
    } else {
      co.slug = s;
    }
    slugAssigned[co.slug] = (slugAssigned[co.slug] || 0) + 1;
  }

  // Group transactions by ticker+country
  const txnMap = new Map();
  for (const t of allTxns) {
    const key = `${t.ticker}|${t.country_code}`;
    if (!txnMap.has(key)) txnMap.set(key, []);
    txnMap.get(key).push(t);
  }

  // Generate pages
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let generated = 0;

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

  process.stdout.write('  Updating sitemap.xml… ');
  updateSitemap(companies);
  console.log('done');

  process.stdout.write('  Updating vercel.json… ');
  const added = updateVercelJson();
  console.log(added ? 'added /stocks/:slug rewrite' : 'already present');

  console.log(`\n── Done ────────────────────────────────────────────────────\n`);
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { fetchAllTransactions, aggregateCompanies, generateHTML, makeSlugFromName, PRIORITY };
