'use strict';
// Generates SEO insider profile pages at /insiders/{slug}
// Usage:  node scripts/generate-insider-pages.js [--limit N]

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const LIMIT       = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i+1]) : 500; })();
const OUT_DIR     = path.resolve(__dirname, '../frontend/public/insiders');
const SITEMAP     = path.resolve(__dirname, '../frontend/public/sitemap.xml');
const VERCEL_JSON = path.resolve(__dirname, '../frontend/vercel.json');
const BASE_URL    = 'https://www.insidersalpha.com';
const YEAR        = new Date().getFullYear();
const TODAY       = new Date().toISOString().slice(0, 10);

// Data-quality guard: a handful of rows in the DB have obviously-corrupted
// prices (e.g. a real case: price_per_share=900000 on a small-cap Italian
// stock -> implied EUR 1.8 TRILLION for one transaction). Publishing that on
// a real named person's page would be both wrong and embarrassing. Anything
// above this is excluded from aggregation/display — checked against the
// full DB (only 8 rows exceed it, next-highest legitimate row is ~EUR 800M).
const MAX_PLAUSIBLE_TXN_EUR = 1_000_000_000;

const COUNTRY = {
  IT: { name: 'Italy',          flag: '🇮🇹', regulator: 'Consob',             mktSlug: 'italy' },
  FR: { name: 'France',         flag: '🇫🇷', regulator: 'AMF',                mktSlug: 'france' },
  DE: { name: 'Germany',        flag: '🇩🇪', regulator: 'BaFin',              mktSlug: 'germany' },
  ES: { name: 'Spain',          flag: '🇪🇸', regulator: 'CNMV',               mktSlug: 'spain' },
  BE: { name: 'Belgium',        flag: '🇧🇪', regulator: 'FSMA',               mktSlug: 'belgium' },
  NL: { name: 'Netherlands',    flag: '🇳🇱', regulator: 'AFM',                mktSlug: 'netherlands' },
  FI: { name: 'Finland',        flag: '🇫🇮', regulator: 'FIN-FSA',            mktSlug: 'finland' },
  DK: { name: 'Denmark',        flag: '🇩🇰', regulator: 'Danish FSA',         mktSlug: 'denmark' },
  NO: { name: 'Norway',         flag: '🇳🇴', regulator: 'Finanstilsynet',     mktSlug: 'norway' },
  SE: { name: 'Sweden',         flag: '🇸🇪', regulator: 'Finansinspektionen', mktSlug: 'sweden' },
  CH: { name: 'Switzerland',    flag: '🇨🇭', regulator: 'FINMA',              mktSlug: 'switzerland' },
  GB: { name: 'United Kingdom', flag: '🇬🇧', regulator: 'FCA',                mktSlug: 'united-kingdom' },
  PT: { name: 'Portugal',       flag: '🇵🇹', regulator: 'CMVM',               mktSlug: 'portugal' },
  LU: { name: 'Luxembourg',     flag: '🇱🇺', regulator: 'CSSF',               mktSlug: 'luxembourg' },
  PL: { name: 'Poland',         flag: '🇵🇱', regulator: 'GPW/KNF',            mktSlug: 'poland' },
  KR: { name: 'South Korea',    flag: '🇰🇷', regulator: 'FSC/FSS',            mktSlug: 'south-korea' },
};

const CURRENCY_BY_COUNTRY = {
  IT:'EUR', FR:'EUR', DE:'EUR', ES:'EUR', BE:'EUR', NL:'EUR', FI:'EUR', PT:'EUR', LU:'EUR',
  NO:'NOK', SE:'SEK', DK:'DKK', CH:'CHF', GB:'GBP', KR:'KRW', PL:'PLN',
};

const FX_TO_EUR = {
  EUR: 1, GBP: 1.17, SEK: 0.088, NOK: 0.086,
  DKK: 0.134, PLN: 0.235, KRW: 0.00068, CHF: 1.04,
};

const CURRENCY_SYMBOL = { EUR:'€', GBP:'£', SEK:'SEK ', NOK:'NOK ', DKK:'DKK ', PLN:'PLN ', KRW:'₩', CHF:'CHF ' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function currencyOf(row) {
  return row.currency || CURRENCY_BY_COUNTRY[row.country_code] || 'EUR';
}

function eurValue(row) {
  return Math.abs(Number(row.total_value || 0)) * (FX_TO_EUR[currencyOf(row)] ?? 1);
}

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
  if (v >= 1e9)  return `${sym}${(v/1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `${sym}${(v/1e6).toFixed(2)}M`;
  if (v >= 1e3)  return `${sym}${(v/1e3).toFixed(1)}K`;
  return `${sym}${v.toFixed(0)}`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

// "2 purchases worth —" reads as broken copy when every matching transaction
// had an undisclosed value (e.g. a transfer filed with price=0, total=null).
// Say so in words instead of leaking the em-dash placeholder into prose.
function valuePhrase(count, totalEur, noun) {
  const label = `${count} ${noun}${count !== 1 ? 's' : ''}`;
  if (count === 0) return label;
  return totalEur > 0 ? `${label} worth ${formatValue(totalEur, 'EUR')}` : `${label} (value not disclosed)`;
}

function simplifyRole(role) {
  if (!role) return 'Insider';
  const r = role.toLowerCase();
  if (r.includes('chief executive') || r.includes('ceo')) return 'CEO';
  if (r.includes('chief financial') || r.includes('cfo')) return 'CFO';
  if (r.includes('chief operating') || r.includes('coo')) return 'COO';
  if (r.includes('chairman') || r.includes('président') || r.includes('presidente')) return 'Chairman';
  if (r.includes('president')) return 'President';
  if (r.includes('director') || r.includes('administrateur')) return 'Director';
  if (r.includes('board')) return 'Director';
  if (r.includes('member')) return 'Director';
  return 'Insider';
}

// Legal-entity name detector — a meaningful slice of insider_name values are
// actually corporate filers, trusts, or funds ("BOUYGUES SA", "EXPO LAHE,
// S.A. de C.V.", "Jeffrey and Laura Ubben 2000 Trust") rather than a named
// individual. Publishing a "person profile" for a company would be wrong,
// so these are excluded from insider pages entirely.
//
// Short abbreviations (SA, SE, NV, BV, ASA, A/S) are checked as a TRAILING
// token on the name clause only, not anywhere in the string — checking
// anywhere causes false positives on real given names ("Åsa" contains "sa";
// after JS's ASCII-only \b treats "Å" as non-word, "\bsa\b" would wrongly
// match inside it). Real company suffixes trail the name; real first names
// don't. "GROUP"/"GROUPE"/"HOLDING"/leading "SOCIETE" are checked only on
// the clause before the first comma, since they can legitimately appear in
// a real person's job-title text after a comma (e.g. "...DGD de GROUPE
// SEPRIC"). Longer, more distinctive tokens (GMBH, TRUST, SPA, spelled-out
// legal forms) are safe to check anywhere.
const ENTITY_SAFE_ANYWHERE_RE = /\b(GMBH|PLC|SARL|LLC|OYJ|CORP|TRUST|FOUNDATION|FONDATION|ASSOCIATION|FUND|FONDS|PARTNERS|CAPITAL|SPA)\b|S\.P\.A\.|LEGAL ENTITY IDENTIFIER|CLOSELY ASSOCIATED|PART OF MANAGEMENT|S\.A\.\s+DE\s+C\.V\.|CONSEIL D.ADMINISTRATION|S\.A\.?\s*R\.?\s*L\.?\b/i;
const SPELLED_OUT_ENTITY_RE = /soci[ée]t[ée]\s+(europ[ée]enne|anonyme|par\s+actions|[àa]\s+responsabilit[ée])|aktiengesellschaft|naamloze\s+vennootschap|aktiebolag|gesellschaft\s+mit\s+beschr[äa]nkter\s+haftung|sociedad\s+an[óo]nima|societ[àa]\s+per\s+azioni/i;
const TRAILING_ABBR_RE = /\b(S\.?A\.?|N\.?V\.?|B\.?V\.?|LTD\.?|S\.?E\.?|ASA|A\/S)\.?$/i;
const FIRST_CLAUSE_ENTITY_RE = /\b(societe|soci[ée]t[ée]|group|groupe|holding)\b/i;

function looksLikeEntity(rawName) {
  const name = rawName.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (ENTITY_SAFE_ANYWHERE_RE.test(name)) return true;
  if (SPELLED_OUT_ENTITY_RE.test(name)) return true;
  const firstClause = name.split(',')[0].trim();
  return TRAILING_ABBR_RE.test(firstClause) || FIRST_CLAUSE_ENTITY_RE.test(firstClause);
}

// Ordered longest-first so compound words match before fragments — mirrors
// scripts/generate-stock-pages.js's company-slug logic exactly, so links
// between insider pages and stock pages resolve to the same slug.
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

function makeNameSlug(name) {
  let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/, '');
  return s;
}

// A shorter name is treated as the same insider as a longer one that starts
// with it, IF the longer one continues at a word boundary. This fixes cases
// like "Thomas TRIOMPHE" vs "Thomas TRIOMPHE, Vice-Président Exécutif
// (Vaccins)" for the SAME real person (role text bled into the name field on
// some filings but not others) — without risking merging two different
// people who happen to share a "Lastname, Firstname" formatted name.
function isNamePrefix(shortName, longName) {
  const s = shortName.trim().toLowerCase();
  const l = longName.trim().toLowerCase();
  if (l.length <= s.length || !l.startsWith(s)) return false;
  const nextChar = l[s.length];
  return nextChar === ',' || nextChar === ' ' || nextChar === '(';
}

// Collapses name variants WITHIN each company (never across companies, to
// avoid merging two different people who happen to share a name).
// Between two names that are identical except for case (e.g. "MASSIMO SEGRE"
// vs "Massimo Segre" — same filing, different scraper runs), prefer whichever
// isn't ALL CAPS, since that's usually just a source-document formatting
// artifact rather than the person's actual name casing.
function pickBetterCasing(a, b) {
  const isAllCaps = s => s === s.toUpperCase() && s !== s.toLowerCase();
  if (isAllCaps(a) && !isAllCaps(b)) return b;
  if (isAllCaps(b) && !isAllCaps(a)) return a;
  return a < b ? a : b; // deterministic tiebreak
}

function normalizeNamesPerCompany(rows) {
  const byCompany = new Map();
  for (const r of rows) {
    const key = `${r.company}|${r.country_code}`;
    if (!byCompany.has(key)) byCompany.set(key, new Set());
    byCompany.get(key).add(r.insider_name.trim());
  }
  const canonical = new Map(); // `${company}|${country}|${originalName}` -> canonicalName
  for (const [key, namesSet] of byCompany) {
    let names = [...namesSet];
    const local = new Map(); // raw name (within this company) -> canonical name

    // Pass 1: collapse case-insensitive-identical variants to one canonical form.
    const byLower = new Map();
    for (const n of names) {
      const lower = n.toLowerCase();
      byLower.set(lower, byLower.has(lower) ? pickBetterCasing(byLower.get(lower), n) : n);
    }
    for (const n of names) local.set(n, byLower.get(n.toLowerCase()));
    names = [...new Set(byLower.values())];

    // Pass 2: collapse "Name" vs "Name, role text..." variants (see isNamePrefix).
    names.sort((a, b) => a.length - b.length);
    const shortenedTo = new Map(); // post-pass-1 name -> shortest prefix match
    for (const longer of names) {
      let best = longer;
      for (const shorter of names) {
        if (shorter.length < best.length && isNamePrefix(shorter, longer)) best = shorter;
      }
      shortenedTo.set(longer, best);
    }
    for (const [raw, midName] of local) canonical.set(`${key}|${raw}`, shortenedTo.get(midName) || midName);
  }
  for (const r of rows) {
    const key = `${r.company}|${r.country_code}|${r.insider_name.trim()}`;
    r.insider_name = canonical.get(key) || r.insider_name.trim();
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchAllTransactions() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_transactions')
      .select('id,company,ticker,country_code,insider_name,insider_role,transaction_type,transaction_date,shares,price_per_share,total_value,currency,is_cluster_buy,is_repetitive_buy,is_pre_blackout_buy,is_price_dip,is_unusual_price')
      .not('insider_name', 'is', null)
      .neq('insider_name', 'Not disclosed')
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function fetchAllPerformance() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_performance')
      .select('transaction_id,return_30d,return_90d,return_180d,hit_rate_30d,hit_rate_90d,hit_rate_180d')
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const byId = new Map();
  for (const p of all) byId.set(p.transaction_id, p);
  return byId;
}

// A flat total_value cap alone misses a real bug pattern: a small share
// count times a corrupted price_per_share can still land under the cap
// while the PRICE itself is nonsensical (observed: Xavier Niel bought 103
// UNIBAIL-RODAMCO-WESTFIELD shares at price_per_share=5,000,000 — the same
// person's other buy of the same stock, two months apart, was at 105.31;
// company total was only EUR 515M, under the EUR 1B cap, so it would've
// been published as fact otherwise). Guard against this by comparing each
// row's price to its own company's median price across the whole dataset,
// and dropping rows priced >20x or <1/20th of that peer median.
function buildCompanyMedianPrices(rows) {
  const byCompany = new Map();
  for (const r of rows) {
    if (!(Number(r.price_per_share) > 0)) continue;
    const key = `${r.company}|${r.country_code}`;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(Number(r.price_per_share));
  }
  const medians = new Map();
  for (const [key, prices] of byCompany) {
    if (prices.length < 3) continue; // not enough peers to trust a median
    prices.sort((a, b) => a - b);
    medians.set(key, prices[Math.floor(prices.length / 2)]);
  }
  return medians;
}

function isPricePlausible(row, companyMedians) {
  const price = Number(row.price_per_share);
  if (!(price > 0)) return true; // grants (price=0) aren't judged here
  const median = companyMedians.get(`${row.company}|${row.country_code}`);
  if (median == null) return true; // no peer data to compare against
  const ratio = price / median;
  return ratio <= 20 && ratio >= 0.05;
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

function aggregateInsiders(rawRows, perfById) {
  const companyMedians = buildCompanyMedianPrices(rawRows);
  const rows = rawRows.filter(r =>
    !looksLikeEntity(r.insider_name) &&
    eurValue(r) <= MAX_PLAUSIBLE_TXN_EUR &&
    isPricePlausible(r, companyMedians));
  normalizeNamesPerCompany(rows);

  const groups = new Map(); // `${name}|${company}|${cc}` -> { name, company, cc, txns:[] }
  for (const r of rows) {
    const key = `${r.insider_name}|${r.company}|${r.country_code}`;
    if (!groups.has(key)) groups.set(key, { name: r.insider_name, company: r.company, cc: r.country_code, ticker: r.ticker, txns: [] });
    groups.get(key).txns.push(r);
  }

  const qualifying = [];
  for (const g of groups.values()) {
    if (g.txns.length < 3) continue;
    const sorted = [...g.txns].sort((a, b) => (b.transaction_date || '').localeCompare(a.transaction_date || ''));
    const buys  = sorted.filter(t => (t.transaction_type || '').toUpperCase() === 'BUY');
    const sells = sorted.filter(t => (t.transaction_type || '').toUpperCase() === 'SELL');
    const totalValueEur    = sorted.reduce((s, t) => s + eurValue(t), 0);
    const totalBuyValueEur = buys.reduce((s, t) => s + eurValue(t), 0);
    const totalSellValueEur = sells.reduce((s, t) => s + eurValue(t), 0);

    const perfRows = buys.map(t => perfById.get(t.id)).filter(Boolean);
    const avg = key => {
      const vals = perfRows.map(p => p[key]).filter(v => v !== null && v !== undefined);
      return vals.length ? vals.reduce((s, v) => s + Number(v), 0) / vals.length : null;
    };
    const hitRate = key => {
      const vals = perfRows.map(p => p[key]).filter(v => v !== null && v !== undefined);
      return vals.length ? vals.filter(Boolean).length / vals.length : null;
    };

    qualifying.push({
      name: g.name, company: g.company, cc: g.cc, ticker: g.ticker,
      txns: sorted, buys, sells,
      totalValueEur, totalBuyValueEur, totalSellValueEur,
      latestRole: sorted[0].insider_role || '',
      latestDate: sorted[0].transaction_date,
      earliestDate: sorted[sorted.length - 1].transaction_date,
      hasCluster:    sorted.some(t => t.is_cluster_buy),
      hasRepetitive: sorted.some(t => t.is_repetitive_buy),
      hasPreBlackout: sorted.some(t => t.is_pre_blackout_buy),
      hasPriceDip:   sorted.some(t => t.is_price_dip),
      perfCount: perfRows.length,
      avgReturn30d:  avg('return_30d'),
      avgReturn90d:  avg('return_90d'),
      avgReturn180d: avg('return_180d'),
      hitRate30d: hitRate('hit_rate_30d'),
    });
  }

  // Slugs: bare name-slug when a name maps to exactly one company among
  // qualifying groups, else disambiguate with the company slug.
  const nameCompanyCount = new Map();
  for (const q of qualifying) {
    const k = q.name.toLowerCase();
    if (!nameCompanyCount.has(k)) nameCompanyCount.set(k, new Set());
    nameCompanyCount.get(k).add(`${q.company}|${q.cc}`);
  }
  for (const q of qualifying) {
    const nameSlug = makeNameSlug(q.name);
    const companies = nameCompanyCount.get(q.name.toLowerCase());
    q.slug = companies.size > 1 ? `${nameSlug}-${makeCompanySlug(q.company)}` : nameSlug;
  }

  qualifying.sort((a, b) => b.totalValueEur - a.totalValueEur);
  return qualifying.slice(0, LIMIT);
}

// ── HTML generator ────────────────────────────────────────────────────────────

function generateHTML(ins) {
  const ctry = COUNTRY[ins.cc] || { name: ins.cc, flag: '', regulator: ins.cc, mktSlug: ins.cc.toLowerCase() };
  const currency = currencyOf(ins.txns[0]);
  const role = simplifyRole(ins.latestRole);
  const companySlug = makeCompanySlug(ins.company);
  const companyUrl = `${BASE_URL}/stocks/${companySlug}-insider-transactions`;
  const canonUrl = `${BASE_URL}/insiders/${ins.slug}`;
  const ratio = (ins.buys.length + ins.sells.length) > 0 ? Math.round(ins.buys.length / (ins.buys.length + ins.sells.length) * 100) : 0;

  const metaDesc = `${ins.name} (${role} at ${ins.company}) insider trading history: ${ins.txns.length} transactions, ${valuePhrase(ins.buys.length, ins.totalBuyValueEur, 'purchase')}. Free MAR Article 19 data, updated daily.`;

  const rows = ins.txns.slice(0, 40).map(t => {
    const isBuy = (t.transaction_type || '').toUpperCase() === 'BUY';
    const badges = [
      t.is_cluster_buy    ? '🔄' : '',
      t.is_price_dip      ? '📉' : '',
      t.is_pre_blackout_buy ? '⚠️' : '',
      t.is_repetitive_buy ? '🔁' : '',
    ].filter(Boolean).join(' ');
    return `<tr>
          <td>${esc(t.transaction_date || '—')}</td>
          <td><span class="${isBuy ? 'type-buy' : 'type-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${t.shares ? Number(t.shares).toLocaleString('en') : '—'}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${t.price_per_share ? formatValue(t.price_per_share, currencyOf(t)) : '—'}</td>
          <td style="font-weight:600;font-family:'JetBrains Mono',monospace;font-size:12px">${formatValue(t.total_value, currencyOf(t))}</td>
          <td style="white-space:nowrap">${badges || '<span style="color:#d1d5db">—</span>'}</td>
        </tr>`;
  }).join('\n');

  const sigBadges = [
    ins.hasCluster     && '<span class="sig sig-cluster">🔄 Cluster buying</span>',
    ins.hasPriceDip    && '<span class="sig sig-dip">📉 Bought after price decline</span>',
    ins.hasPreBlackout && '<span class="sig sig-blackout">⚠️ Pre-blackout buying</span>',
    ins.hasRepetitive  && '<span class="sig sig-repeat">🔁 Repeat buyer</span>',
  ].filter(Boolean).join('\n        ');

  const perfAvailable = ins.perfCount > 0;
  const perfSection = perfAvailable ? `
  <h2>Performance of ${esc(ins.name)}'s purchases</h2>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="val ${ins.avgReturn30d != null && ins.avgReturn30d >= 0 ? 'pos' : 'neg'}">${ins.avgReturn30d != null ? (ins.avgReturn30d >= 0 ? '+' : '') + (ins.avgReturn30d*100).toFixed(1) + '%' : '—'}</div>
      <div class="lbl">Avg 30d return</div>
    </div>
    <div class="stat-card">
      <div class="val ${ins.avgReturn90d != null && ins.avgReturn90d >= 0 ? 'pos' : 'neg'}">${ins.avgReturn90d != null ? (ins.avgReturn90d >= 0 ? '+' : '') + (ins.avgReturn90d*100).toFixed(1) + '%' : '—'}</div>
      <div class="lbl">Avg 90d return</div>
    </div>
    <div class="stat-card">
      <div class="val ${ins.avgReturn180d != null && ins.avgReturn180d >= 0 ? 'pos' : 'neg'}">${ins.avgReturn180d != null ? (ins.avgReturn180d >= 0 ? '+' : '') + (ins.avgReturn180d*100).toFixed(1) + '%' : '—'}</div>
      <div class="lbl">Avg 180d return</div>
    </div>
    <div class="stat-card">
      <div class="val">${ins.hitRate30d != null ? Math.round(ins.hitRate30d*100) + '%' : '—'}</div>
      <div class="lbl">30d hit rate</div>
    </div>
  </div>
  <p style="font-size:12px;color:#9CA3AF">Based on ${ins.perfCount} tracked purchase${ins.perfCount!==1?'s':''} with matured price data. Past performance does not guarantee future results.</p>` : '';

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'InsidersAlpha', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: ctry.name, item: `${BASE_URL}/market/${ctry.mktSlug}-insider-transactions` },
      { '@type': 'ListItem', position: 3, name: ins.company, item: companyUrl },
      { '@type': 'ListItem', position: 4, name: ins.name, item: canonUrl },
    ],
  });

  const faqQuestions = [
    {
      name: `Who is ${ins.name}?`,
      text: `${ins.name} is ${role} at ${ins.company}${ctry.name ? ` (${ctry.name})` : ''}. InsidersAlpha tracks ${ins.name}'s insider share transactions from official ${ctry.regulator} filings under MAR Article 19.`,
    },
    {
      name: `How many shares has ${ins.name} bought or sold?`,
      text: `${ins.name} has made ${ins.txns.length} insider transactions at ${ins.company}, including ${valuePhrase(ins.buys.length, ins.totalBuyValueEur, 'purchase')}${ins.sells.length ? ` and ${valuePhrase(ins.sells.length, ins.totalSellValueEur, 'sale')}` : ''}.`,
    },
    {
      name: `When did ${ins.name} last trade ${ins.company} stock?`,
      text: `${ins.name}'s most recent filed transaction at ${ins.company} was on ${ins.latestDate}. InsidersAlpha updates daily from official ${ctry.regulator} disclosures.`,
    },
  ];
  if (role === 'CEO' || role === 'CFO' || role === 'Chairman') {
    faqQuestions.push({
      name: `Is ${ins.company}'s ${role} buying shares?`,
      text: `${ins.name}, ${role} of ${ins.company}, has ${ins.buys.length} recorded purchase${ins.buys.length!==1?'s':''} on InsidersAlpha, most recently on ${ins.buys[0]?.transaction_date || ins.latestDate}.`,
    });
  }
  const faqLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqQuestions.map(q => ({ '@type': 'Question', name: q.name, acceptedAnswer: { '@type': 'Answer', text: q.text } })),
  });

  const personLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Person',
    name: ins.name,
    jobTitle: ins.latestRole || role,
    worksFor: { '@type': 'Organization', name: ins.company },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(ins.name)} Insider Trading — ${esc(role)} at ${esc(ins.company)} | InsidersAlpha</title>
  <meta name="description" content="${esc(metaDesc)}">
  <meta property="og:title" content="${esc(ins.name)} Insider Trading | InsidersAlpha">
  <meta property="og:description" content="${esc(metaDesc)}">
  <meta property="og:url" content="${canonUrl}">
  <meta property="og:type" content="profile">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${canonUrl}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-RPT36NKE74"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-RPT36NKE74');</script>
  <script type="application/ld+json">${breadcrumbLd}</script>
  <script type="application/ld+json">${personLd}</script>
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
    p{color:#374151;margin-bottom:14px;line-height:1.75}
    .hero-sub{font-size:15px;color:#6B7280;margin-bottom:4px}
    .updated-note{font-size:11px;color:#9CA3AF;margin-bottom:24px}
    .header-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
    .hbadge{background:#f8f8f8;border:1px solid #f0f0f0;border-radius:6px;padding:4px 10px;font-size:12px;color:#6B7280;display:inline-flex;align-items:center;gap:5px}
    .hbadge strong{color:#111318;font-weight:600}
    .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px}
    @media(max-width:560px){.stats-grid{grid-template-columns:1fr 1fr}}
    .stat-card{border:1px solid #f0f0f0;border-radius:9px;padding:14px 16px;text-align:center;background:#fafafa}
    .stat-card .val{font-size:20px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:-.02em;margin-bottom:2px}
    .stat-card .val.pos{color:#15803D}.stat-card .val.neg{color:#DC2626}
    .stat-card .lbl{font-size:10px;color:#9CA3AF;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
    .signal-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:24px}
    .sig{display:inline-block;border-radius:6px;padding:5px 11px;font-size:12px;font-weight:600}
    .sig-cluster{background:#EEF2FF;color:#4338CA}
    .sig-dip{background:#FEF9C3;color:#854D0E}
    .sig-blackout{background:#FFF7ED;color:#C2410C}
    .sig-repeat{background:#F5F3FF;color:#7C3AED}
    .cta-box{background:#0f1117;border-radius:10px;padding:22px 28px;margin:28px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .cta-box p{color:#9CA3AF;font-size:13px;margin:0}
    .cta-box strong{display:block;color:#fff;font-size:15px;font-weight:700;margin-bottom:3px}
    .cta-btn{display:inline-block;background:#fff;color:#0f1117;border-radius:7px;padding:9px 20px;font-size:13px;font-weight:700;white-space:nowrap}
    .cta-btn:hover{background:#f0f0f0;text-decoration:none}
    .txn-table-wrap{overflow-x:auto;margin-bottom:4px;border:1px solid #f0f0f0;border-radius:9px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9CA3AF;border-bottom:1px solid #f0f0f0;background:#fafafa;white-space:nowrap}
    td{padding:10px 12px;border-bottom:1px solid #f6f6f6;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafafa}
    .type-buy{background:#DCFCE7;color:#15803D;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;font-family:'JetBrains Mono',monospace}
    .type-sell{background:#FEE2E2;color:#DC2626;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;font-family:'JetBrains Mono',monospace}
    .faq-item{border-bottom:1px solid #f0f0f0;padding:16px 0}
    .faq-item:last-child{border-bottom:none}
    .faq-item h3{font-size:14px;font-weight:600;margin:0 0 6px}
    .divider{height:1px;background:#f0f0f0;margin:32px 0}
    footer{border-top:1px solid #f0f0f0;padding:20px 24px;text-align:center;font-size:12px;color:#9CA3AF}
    footer a{color:#9CA3AF;margin:0 8px}footer a:hover{color:#111318}
    @media(max-width:640px){.wrap{padding:32px 16px 60px}h1{font-size:22px}}
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
    <a href="/market/${ctry.mktSlug}-insider-transactions">${ctry.flag} ${ctry.name}</a><span>›</span>
    <a href="${companyUrl.replace(BASE_URL,'')}">${esc(ins.company)}</a><span>›</span>
    ${esc(ins.name)}
  </nav>

  <h1>${esc(ins.name)} Insider Trading</h1>
  <p class="hero-sub">${esc(role)} at <a href="${companyUrl.replace(BASE_URL,'')}">${esc(ins.company)}</a> ${ctry.flag} — ${ins.txns.length} insider transactions tracked from official ${ctry.regulator} filings.</p>
  <p class="updated-note">Last updated: ${TODAY} · Data sourced from MAR Article 19 regulatory disclosures</p>

  <div class="header-badges">
    <span class="hbadge">${ctry.flag} <strong>${ctry.name}</strong></span>
    <span class="hbadge">📋 <strong>${ctry.regulator}</strong></span>
    <span class="hbadge">🔄 Updated daily</span>
  </div>

  <div class="stats-grid">
    <div class="stat-card"><div class="val">${ins.txns.length}</div><div class="lbl">Total Transactions</div></div>
    <div class="stat-card"><div class="val" style="color:#15803D">${ins.buys.length}</div><div class="lbl">Buys</div></div>
    <div class="stat-card"><div class="val" style="color:#DC2626">${ins.sells.length}</div><div class="lbl">Sells</div></div>
    <div class="stat-card"><div class="val sm">${formatValue(ins.totalBuyValueEur,'EUR')}</div><div class="lbl">Total Bought</div></div>
  </div>

  ${sigBadges ? `<div class="signal-row">\n        ${sigBadges}\n      </div>` : ''}

  <div class="cta-box">
    <div>
      <strong>Track ${esc(ins.name)} and every other insider free</strong>
      <p>Live filings with conviction scores, signal badges, and post-trade return tracking across 16 markets.</p>
    </div>
    <a href="/" class="cta-btn">View live data →</a>
  </div>
  ${perfSection}

  <h2>All transactions</h2>
  <div class="txn-table-wrap">
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Shares</th><th>Price</th><th>Value</th><th>Signals</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
  ${ins.txns.length > 40 ? `<p style="font-size:11px;color:#9CA3AF;margin-top:6px">Showing 40 most recent of ${ins.txns.length} transactions · <a href="/" style="color:#9CA3AF">View full history in app →</a></p>` : ''}

  <div class="divider"></div>

  <h2>Frequently asked questions</h2>
  <div>
    ${faqQuestions.map(q => `<div class="faq-item"><h3>${esc(q.name)}</h3><p>${esc(q.text)}</p></div>`).join('\n    ')}
  </div>

  <div class="divider"></div>

  <h2>Related pages</h2>
  <div class="header-badges">
    <a href="${companyUrl.replace(BASE_URL,'')}" class="hbadge">🏢 ${esc(ins.company)} insider transactions</a>
    <a href="/market/${ctry.mktSlug}-insider-transactions" class="hbadge">${ctry.flag} All ${ctry.name} insider transactions</a>
    <a href="/methodology" class="hbadge">How signals are calculated</a>
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

// ── Sitemap ───────────────────────────────────────────────────────────────────

function updateSitemap(insiders) {
  let xml = fs.readFileSync(SITEMAP, 'utf8');
  xml = xml.replace(/<url>\s*<loc>[^<]*\/insiders\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');
  const newEntries = insiders.map(ins => `  <url>
    <loc>${BASE_URL}/insiders/${ins.slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
    <lastmod>${ins.latestDate || TODAY}</lastmod>
  </url>`).join('\n');
  xml = xml.replace('</urlset>', `${newEntries}\n</urlset>`);
  xml = xml.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(SITEMAP, xml, 'utf8');
}

// ── vercel.json ───────────────────────────────────────────────────────────────

function updateVercelJson() {
  const vj = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  const rewrite = { source: '/insiders/:slug', destination: '/insiders/:slug.html' };
  if (vj.rewrites.some(r => r.source === '/insiders/:slug')) return false;
  const catchAll = vj.rewrites.findIndex(r => r.source === '/((?!api/).*)');
  if (catchAll >= 0) vj.rewrites.splice(catchAll, 0, rewrite);
  else vj.rewrites.push(rewrite);
  fs.writeFileSync(VERCEL_JSON, JSON.stringify(vj, null, 2) + '\n', 'utf8');
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Insider Profile Page Generator ────────────────────────`);
  console.log(`  Limit: top ${LIMIT} insiders by EUR-equivalent transaction value`);

  process.stdout.write('  Fetching transactions… ');
  const rawRows = await fetchAllTransactions();
  console.log(`${rawRows.length} rows`);

  process.stdout.write('  Fetching performance data… ');
  const perfById = await fetchAllPerformance();
  console.log(`${perfById.size} rows`);

  const insiders = aggregateInsiders(rawRows, perfById);
  console.log(`  ${insiders.length} insiders qualify (3+ transactions, top ${LIMIT} by value)\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let generated = 0;
  for (const ins of insiders) {
    const html = generateHTML(ins);
    fs.writeFileSync(path.join(OUT_DIR, `${ins.slug}.html`), html, 'utf8');
    generated++;
  }
  console.log(`  Generated: ${generated} pages`);

  process.stdout.write('  Updating sitemap.xml… ');
  updateSitemap(insiders);
  console.log('done');

  process.stdout.write('  Updating vercel.json… ');
  const added = updateVercelJson();
  console.log(added ? 'added /insiders/:slug rewrite' : 'already present');

  console.log(`\n── Done ───────────────────────────────────────────────────\n`);
}

main().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
