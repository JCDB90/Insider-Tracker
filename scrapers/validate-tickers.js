'use strict';
/**
 * Ticker Validation — check every distinct ticker in the DB against Yahoo Finance
 *
 * Replicates the same candidate-building logic as CompanyPage.jsx:
 *   ticker + country suffix → bare base + suffix → first-4-chars + suffix
 *   Swedish B-shares: also tries root-B.ST variants
 *
 * Output:
 *   - Per-country summary (valid / broken / no-ticker counts)
 *   - List of broken tickers with suggested Yahoo symbols to investigate
 *   - Tickers that return data on a fallback but not the primary symbol
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const DELAY_MS   = 350;   // per Yahoo request
const BATCH_SIZE = 5;     // concurrent requests

const COUNTRY_SUFFIX = {
  AT:'.VI', BE:'.BR', CA:'.TO', CH:'.SW', CZ:'.PR',
  DE:'.DE', DK:'.CO', ES:'.MC', FI:'.HE', FR:'.PA',
  GB:'.L',  HK:'.HK', IE:'.IR', IT:'.MI', JP:'.T',
  KR:'.KS', LU:'.LU', NL:'.AS', NO:'.OL', PL:'.WA',
  PT:'.LS', SE:'.ST', SG:'.SI', ZA:'.JO', AU:'.AX',
};

// ── Yahoo Finance fetch ────────────────────────────────────────────────────────

function fetchSymbol(symbol) {
  return new Promise(resolve => {
    // Use a 30-day range (fast, recent data)
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&includePrePost=false`;
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
          const hasData = closes.some(v => v != null && v > 0);
          resolve({ ok: hasData, status: res.statusCode, meta: data?.chart?.result?.[0]?.meta });
        } catch { resolve({ ok: false, status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Candidate builder (mirrors CompanyPage.jsx buildYahooSymbolCandidates) ────

function buildCandidates(ticker, countryCode, company) {
  const sfx = COUNTRY_SUFFIX[countryCode] || '';

  const derived = (!ticker && company)
    ? company.replace(/\s+(AB|SA|NV|BV|PLC|SE|SAS|AG|GmbH)[\s.]*$/i, '').trim()
        .split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '')
    : null;

  const base = ticker || derived || '';
  if (!base) return [];

  const bare = base.replace(/[-.].*$/, ''); // MIDS-B → MIDS, ELAN-B → ELAN

  const candidates = [
    base + sfx,
    bare + sfx,
    base.slice(0, 4) + sfx,
  ];

  // Swedish B-share variants
  if (countryCode === 'SE' && !base.includes('-')) {
    const root = base.replace(/[BE]$/, '');
    candidates.push(
      root + '-B' + sfx,
      root + 'B' + sfx,
      root.slice(0, 4) + '-B' + sfx,
    );
  }

  if (!sfx) candidates.push(base);

  return [...new Set(candidates)].filter(Boolean);
}

// ── Load distinct tickers from Supabase ───────────────────────────────────────

async function loadTickers() {
  const rows = [];
  let from = 0;
  while (true) {
    // Select every distinct (ticker, company, country_code) combination
    const { data, error } = await sb
      .from('insider_transactions')
      .select('ticker, company, country_code')
      .not('ticker', 'is', null)
      .neq('ticker', '')
      .order('country_code')
      .range(from, from + 999);
    if (error) throw new Error('Load tickers: ' + error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Deduplicate to one entry per (ticker, country_code)
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const key = `${r.ticker}|${r.country_code}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  return unique;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('📊  Ticker Validator — checking all DB tickers against Yahoo Finance');
  console.log('');
  const t0 = Date.now();

  console.log('  Loading distinct tickers from Supabase…');
  const tickers = await loadTickers();
  console.log(`  ${tickers.length} distinct (ticker, country) combinations\n`);

  const results = {
    valid:       [],   // primary symbol works
    fallback:    [],   // primary fails but a candidate works
    broken:      [],   // all candidates fail
  };

  let done = 0;
  const total = tickers.length;

  for (let i = 0; i < tickers.length; i++) {
    const { ticker, company, country_code } = tickers[i];
    const candidates = buildCandidates(ticker, country_code, company);

    if (!candidates.length) {
      results.broken.push({ ticker, company, country_code, tried: [], reason: 'no candidates' });
      done++;
      continue;
    }

    let foundAt = null;
    for (const sym of candidates) {
      const r = await fetchSymbol(sym);
      await delay(DELAY_MS);
      if (r.ok) { foundAt = sym; break; }
    }

    const entry = { ticker, company, country_code, primary: candidates[0], candidates, foundAt };

    if (!foundAt) {
      results.broken.push(entry);
    } else if (foundAt === candidates[0]) {
      results.valid.push(entry);
    } else {
      results.fallback.push(entry); // works, but not on primary symbol
    }

    done++;
    if (done % 20 === 0 || done === total) {
      process.stdout.write(`  Progress: ${done}/${total} (${Math.round(done/total*100)}%)  valid:${results.valid.length}  fallback:${results.fallback.length}  broken:${results.broken.length}\r`);
    }
  }

  process.stdout.write('\n');

  // ── Report ──────────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅  Validation complete in ${elapsed}s\n`);
  console.log(`  VALID    (primary symbol works): ${results.valid.length}`);
  console.log(`  FALLBACK (works on alt symbol):  ${results.fallback.length}`);
  console.log(`  BROKEN   (no symbol works):      ${results.broken.length}`);
  console.log('');

  // ── Per-country breakdown ───────────────────────────────────────────────────
  const countryStats = {};
  for (const r of [...results.valid, ...results.fallback, ...results.broken]) {
    const cc = r.country_code;
    if (!countryStats[cc]) countryStats[cc] = { valid: 0, fallback: 0, broken: 0 };
  }
  for (const r of results.valid)    countryStats[r.country_code].valid++;
  for (const r of results.fallback) countryStats[r.country_code].fallback++;
  for (const r of results.broken)   countryStats[r.country_code].broken++;

  console.log('── Per-country breakdown ──────────────────────────────────────────────');
  const ccList = Object.entries(countryStats).sort((a, b) => {
    const aTotal = a[1].broken + a[1].fallback;
    const bTotal = b[1].broken + b[1].fallback;
    return bTotal - aTotal;
  });
  for (const [cc, s] of ccList) {
    const total = s.valid + s.fallback + s.broken;
    const pct = Math.round(s.valid / total * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    console.log(`  ${cc.padEnd(3)} ${bar} ${pct}%  valid:${s.valid}  fallback:${s.fallback}  broken:${s.broken}`);
  }
  console.log('');

  // ── Fallback detail (primary fails, but alt works — update TICKER_MAP) ─────
  if (results.fallback.length) {
    console.log('── FALLBACK — works on alt symbol (fix primary ticker in scraper) ───────');
    for (const r of results.fallback.sort((a, b) => a.country_code.localeCompare(b.country_code))) {
      const stored = r.ticker || '(none)';
      console.log(`  [${r.country_code}] ${r.company?.slice(0, 40).padEnd(40)} stored:${stored.padEnd(12)} works:${r.foundAt}`);
    }
    console.log('');
  }

  // ── Broken detail ──────────────────────────────────────────────────────────
  if (results.broken.length) {
    console.log('── BROKEN — no Yahoo Finance data found ────────────────────────────────');
    for (const r of results.broken.sort((a, b) => a.country_code.localeCompare(b.country_code))) {
      const tried = r.candidates?.join(', ') || 'none';
      console.log(`  [${r.country_code}] ${r.company?.slice(0, 40).padEnd(40)} ticker:${(r.ticker||'').padEnd(12)} tried:${tried}`);
    }
    console.log('');
  }

  console.log(`Total tickers checked: ${total}. Valid: ${results.valid.length} (${Math.round(results.valid.length/total*100)}%)`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
