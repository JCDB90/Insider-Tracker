'use strict';
/**
 * Watchlist IR Monitor — Buyback Keyword Detector
 *
 * Fetches the Investor Relations / press-release page for each watchlist stock
 * and looks for a link whose OWN text names a buyback/repurchase. When found,
 * stores an entry in buyback_programs so the Watchlist tab can surface it.
 *
 * Runs weekly (alongside the other buyback scrapers).  Designed to be
 * resilient: pages that timeout, block, or require JS are skipped gracefully.
 *
 * Fixed 2026-07-25: previously matched a buyback keyword anywhere within
 * ±150 chars of ANY link on the page (not the link's own text), and fell back
 * to a page-wide "mention found somewhere" row when no specific link matched.
 * Every row this had ever saved for BE/NL was a false positive from that —
 * generic nav links like "Shares in issue" or "Media library" sitting near an
 * unrelated buyback mention elsewhere on the page, not real announcements.
 * Both loosened match paths were removed; a row now only gets created when a
 * link's own visible text contains a buyback keyword.
 */

const https   = require('https');
const http    = require('http');
const { saveBuybackPrograms } = require('../lib/db');

const SOURCE         = 'Watchlist IR Monitor';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '30');
const REQUEST_TIMEOUT = 20000;  // 20 s per page

// ── Watchlist IR pages ────────────────────────────────────────────────────────

const WATCHLIST = [
  {
    ticker: 'VID',   company: 'Vidrala',       country_code: 'ES', currency: 'EUR',
    urls: [
      'https://www.vidrala.com/en/investors/',
      'https://www.vidrala.com/es/inversores-y-accionistas/',
    ],
  },
  {
    ticker: 'JEN',   company: 'Jensen Group',   country_code: 'BE', currency: 'EUR',
    urls: [
      'https://www.jensen-group.com/en/investor-relations/press-releases',
      'https://www.jensen-group.com/investor-relations/',
    ],
  },
  {
    ticker: 'THEP',  company: 'Thermador Groupe', country_code: 'FR', currency: 'EUR',
    urls: [
      'https://www.thermador-groupe.fr/fr/finance/communiques-de-presse',
      'https://www.thermador-groupe.fr/en/finance/',
    ],
  },
  {
    ticker: 'FLOW',  company: 'Flow Traders',   country_code: 'NL', currency: 'EUR',
    urls: [
      'https://www.flowtraders.com/news',
      'https://ir.flowtraders.com/news-events/press-releases',
    ],
  },
  {
    ticker: 'PRX',   company: 'Prosus',          country_code: 'NL', currency: 'EUR',
    urls: [
      'https://www.prosus.com/news/press-releases',
      'https://www.prosus.com/news/',
    ],
  },
  {
    ticker: 'ASML',  company: 'ASML',            country_code: 'NL', currency: 'EUR',
    urls: [
      'https://www.asml.com/en/news/press-releases',
      'https://www.asml.com/en/news/',
    ],
  },
];

// Buyback keyword patterns (EN + NL + FR + DE + ES)
const BUYBACK_RE = /\b(buyback|buy[\s-]back|repurchas|share\s+repurchas|treasury\s+shares?|inkoop(?:programma)?|rachat|eigene?\s+aktien|recompra|autocartera)\b/i;

// ── HTTP fetch ────────────────────────────────────────────────────────────────

function fetchPage(urlStr) {
  return new Promise(resolve => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      }, res => {
        // Follow single redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          res.resume();
          return fetchPage(res.headers.location).then(resolve);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = []; let total = 0;
        res.on('data', c => {
          total += c.length; chunks.push(c);
          if (total > 500000) { req.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); }
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ── Text extraction ───────────────────────────────────────────────────────────

function extractRecentBuybackItems(html) {
  if (!html) return [];
  const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Find anchors whose OWN link text names a buyback — not a wide surrounding-
  // page context. A ±150-char proximity window matched generic nav links
  // ("Shares in issue", "Media library", "Download PDF") purely because a
  // buyback mention sat elsewhere nearby on the page (e.g. in a shared footer
  // or an unrelated older news teaser). Every row this scraper had ever saved
  // for BE/NL turned out to be one of these false positives — audited all 120
  // live rows on 2026-07-25, zero were genuine buyback announcements — so the
  // context window is removed entirely, not just narrowed.
  const matches = [];
  const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{1,200}?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(text)) !== null) {
    const href = m[1];
    const inner = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner.length < 5) continue;
    if (BUYBACK_RE.test(inner)) {
      const ctx = text.slice(Math.max(0, m.index - 150), m.index + m[0].length + 150);
      const dateM = ctx.match(/(\d{1,2}[-\/\s]\w{2,10}[-\/\s]\d{2,4}|\d{4}-\d{2}-\d{2})/);
      matches.push({ title: inner.slice(0, 120), href, date: dateM?.[1] || null });
    }
  }

  return { matches };
}

function isoDate(s) {
  if (!s) return null;
  // Try to parse various date formats
  const iso = new Date(s);
  if (!isNaN(iso)) return iso.toISOString().slice(0, 10);
  // "25 Feb 2026" or "Feb 25, 2026"
  const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) {
    const mo = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const mon = mo[m[2].slice(0,3).toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeWatchlistBuybacks() {
  console.log('📋  Watchlist IR Monitor — checking for buyback announcements');
  const t0 = Date.now();

  const dbRows = [];
  const today  = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);

  for (const stock of WATCHLIST) {
    console.log(`  Checking ${stock.ticker} (${stock.company})…`);
    let found = false;

    for (const url of stock.urls) {
      const html = await fetchPage(url);
      if (!html) { console.log(`    ⚠ ${url} — no response`); continue; }

      const { matches } = extractRecentBuybackItems(html);

      if (matches.length === 0) {
        console.log(`    ✓ ${url} — no buyback keywords in any link text`);
        continue;
      }

      console.log(`    🔔 ${url} — buyback keyword detected! ${matches.length} matching links`);

      for (let idx = 0; idx < Math.min(3, matches.length); idx++) {
        const item = matches[idx];
        const execDate = isoDate(item.date) || today;
        if (execDate < cutoff) continue;  // skip old items

        // Use idx to guarantee unique filing_id within same stock+date
        const filingId = `WL-${stock.ticker}-${execDate}-${idx}`;
        dbRows.push({
          filing_id:      filingId,
          country_code:   stock.country_code,
          ticker:         stock.ticker,
          company:        stock.company,
          currency:       stock.currency,
          announced_date: execDate,
          execution_date: execDate,
          status:         'Announced',
          filing_url:     item.href.startsWith('http') ? item.href : `https://${new URL(url).hostname}${item.href}`,
          source_url:     item.href.startsWith('http') ? item.href : `https://${new URL(url).hostname}${item.href}`,
          source:         `${SOURCE} — ${item.title.slice(0, 60)}`,
        });
      }
      found = true;
      break;  // got data from this URL, skip remaining URLs for this stock
    }

    if (!found) console.log(`    — no buyback signals found`);
  }

  if (!dbRows.length) {
    console.log(`  No buyback announcements found across ${WATCHLIST.length} watchlist stocks.`);
    return { saved: 0 };
  }

  // Deduplicate by filing_id before save
  const unique = [...new Map(dbRows.map(r => [r.filing_id, r])).values()];
  console.log(`  Found ${unique.length} announcement(s), saving…`);
  const { error } = await saveBuybackPrograms(unique);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  dbRows.forEach(r => console.log(`    ${r.ticker}: ${r.source.slice(0, 70)}`));
  return { saved: dbRows.length };
}

scrapeWatchlistBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
