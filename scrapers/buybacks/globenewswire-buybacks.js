'use strict';
/**
 * FR / NL / BE — Share Buyback Scraper (GlobeNewswire)
 *
 * Source: GlobeNewswire RSS — country + keyword filtered feed
 *   https://www.globenewswire.com/RssFeed/country/{Country}/keyword/share%20buyback
 *
 * Regulatory sources don't carry a buyback-program category for these markets
 * (AMF BDIF's taxonomy has no such type; confirmed by direct API audit).
 * GlobeNewswire is a press-release wire, not a regulator — these rows should
 * get confidence='medium' once migrations/017_buyback_confidence.sql has been
 * applied (that column doesn't exist yet as of this writing, so it's omitted
 * from the row objects below to avoid upsert failures; add it back once the
 * migration is applied).
 *
 * The feed caps at "the last 20 releases" per country — no pagination — so
 * this is a forward-looking feed going forward, not a deep historical backfill
 * source. Germany/Spain/Italy were tested and return 0 items even for a bare
 * country filter with no keyword, so they aren't covered by this scraper.
 *
 * Two article shapes appear in practice:
 *   A) PROGRAMME ANNOUNCEMENT — "Arcadis announces €175 million share buyback
 *      program ... will commence on 1 October 2025 and run until 1 July 2026
 *      at the latest." → program_start/program_end/max value all extractable.
 *   B) PERIODIC EXECUTION REPORT — "Aramis Group - Declaration of transactions
 *      on own shares conducted from May 11 to May 15, 2026" → company/ISIN/
 *      execution-period only, no program-level max/dates in the text.
 */

const https = require('https');
const { saveBuybackPrograms, logScraperRun } = require('../lib/db');
const { htmlToText } = require('../lib/htmlToText');

const SOURCE          = 'GlobeNewswire';
const RETENTION_DAYS  = parseInt(process.env.LOOKBACK_DAYS || '30');
const DELAY_MS        = 300;

// keywords: 'share buyback' alone missed real French program announcements
// (NEURONES, Crédit Agricole de la Touraine et du Poitou, IPSOS) that only
// surfaced under the single French term 'rachat' — French companies often
// use "rachat d'actions"/"programme de rachat" rather than the English
// phrase. Confirmed via direct feed testing 2026-07-25 that multi-word French
// phrases ("rachat actions", "programme de rachat") return 0 — GlobeNewswire's
// keyword param appears to require all words in exact sequence, not an OR/AND
// of terms, so only single-word 'rachat' works here, not a French phrase.
const COUNTRIES = [
  { code: 'FR', name: 'France',      keywords: ['share buyback', 'rachat'] },
  { code: 'NL', name: 'Netherlands', keywords: ['share buyback'] },
  { code: 'BE', name: 'Belgium',     keywords: ['share buyback'] },
];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetText(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

// ── RSS parsing ────────────────────────────────────────────────────────────

function parseRssItems(xml) {
  if (!xml) return [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map(block => {
    const get = (re) => { const m = block.match(re); return m ? m[1].trim() : null; };
    const link        = get(/<link>([\s\S]*?)<\/link>/);
    const title       = get(/<title>([\s\S]*?)<\/title>/);
    const pubDate     = get(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const identifier  = get(/<dc:identifier>([\s\S]*?)<\/dc:identifier>/);
    const contributor = get(/<dc:contributor>([\s\S]*?)<\/dc:contributor>/);
    const stockM = block.match(/domain="https:\/\/www\.globenewswire\.com\/rss\/stock">([^<]+)</);
    const isinM  = block.match(/domain="https:\/\/www\.globenewswire\.com\/rss\/ISIN">([^<]+)</);
    return {
      link, title, pubDate, identifier,
      company: contributor,
      stock:   stockM ? stockM[1].trim() : null,
      isin:    isinM ? isinM[1].trim() : null,
    };
  });
}

function parsePubDate(s) {
  if (!s) return null;
  const d = new Date(s);   // "Wed, 01 Oct 2025 05:00 GMT"
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── Article body parsing ─────────────────────────────────────────────────────

const MO_MAP = { january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12 };

function parseProseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) {
    const mon = MO_MAP[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  return null;
}

const CCY_SYM = { '€': 'EUR', '£': 'GBP', '$': 'USD' };

function addMonths(dateIso, months) {
  if (!dateIso) return null;
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function parseArticleBody(text, pubDateIso) {
  // "maximum total value of €175 million" / "up to a maximum of €50 million"
  let programMax = null, currency = null;
  const maxM = text.match(/(?:maximum\s+(?:total\s+)?(?:aggregate\s+)?(?:market\s+)?value\s+of|up\s+to(?:\s+a\s+maximum\s+of)?)\s*([€£$]|[A-Z]{3})\s*([\d.,]+)\s*(million|billion|mn|bn)?/i)
           // French AMF Article 241-2 standardized disclosure ("Description of
           // the share buyback program"): "Maximum amount of the program
           // authorized by the Shareholders' Meeting: €218,958,390" — no
           // million/billion shorthand, bare full number after a colon.
           || text.match(/maximum\s+amount\s+of\s+the\s+program(?:me)?[\s\S]{0,80}?:\s*([€£$]|[A-Z]{3})\s*([\d.,]+)\s*(million|billion|mn|bn)?/i);
  if (maxM) {
    currency = CCY_SYM[maxM[1]] || maxM[1].toUpperCase();
    const mult = /billion|bn/i.test(maxM[3] || '') ? 1e9 : /million|mn/i.test(maxM[3] || '') ? 1e6 : 1;
    const v = parseFloat(maxM[2].replace(/,/g, ''));
    if (v) programMax = Math.round(v * mult);
  }

  // "commence on 1 October 2025" / "will start on 1 October 2025"
  const startM = text.match(/(?:commence|start(?:ed|ing)?)\s+(?:on\s+)?(\d{1,2}\s+\w+\s+\d{4})/i);
  const programStart = startM ? parseProseDate(startM[1]) : null;

  // "run until 1 July 2026 at the latest" / "until 1 July 2026"
  const endM = text.match(/(?:run\s+until|until)\s+(\d{1,2}\s+\w+\s+\d{4})(?:\s+at\s+the\s+latest)?/i);
  let programEnd = endM ? parseProseDate(endM[1]) : null;

  // Same French standardized disclosure: authorizations are duration-based
  // ("for a period of 18 months", "not to exceed 18 months from this
  // Meeting"), not an explicit end date — derive one from the duration plus
  // whichever start reference is available (explicit start, else this
  // article's own publish date, since the authorization is announced the
  // same day it's granted in this format).
  if (!programEnd) {
    const durM = text.match(/period\s+(?:of\s+|not\s+(?:to\s+)?exceed(?:ing)?\s+)(\d{1,2})\s+months?/i);
    if (durM) {
      const base = programStart || pubDateIso;
      programEnd = addMonths(base, parseInt(durM[1], 10));
    }
  }

  // Weekly declarations: "conducted from May 11 to May 15, 2026" / "from 11 May to 15 May 2026"
  let execDate = null;
  const periodM = text.match(/from\s+\w+\s+\d{1,2}\s+to\s+(\w+\s+\d{1,2},?\s+\d{4})/i)
               || text.match(/from\s+\d{1,2}\s+\w+\s+to\s+(\d{1,2}\s+\w+\s+\d{4})/i);
  if (periodM) execDate = parseProseDate(periodM[1].replace(',', ''));

  return { programMax, currency, programStart, programEnd, execDate };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeGlobeNewswireBuybacks() {
  console.log('🇫🇷🇳🇱🇧🇪  GlobeNewswire — Share Buyback Programs (FR/NL/BE)');
  const t0 = Date.now();
  const cutoffStr = isoDate(cutoff());
  console.log(`  Lookback: ${RETENTION_DAYS} days (from ${cutoffStr}) — feed caps at last 20 releases/country`);

  const seen   = new Set();
  const dbRows = [];
  let fetched = 0, parsed = 0, skipped = 0;

  for (const country of COUNTRIES) {
    let items = [];
    for (const keyword of country.keywords) {
      const url = `https://www.globenewswire.com/RssFeed/country/${country.name}/keyword/${encodeURIComponent(keyword)}`;
      const xml = await httpsGetText(url);
      items = items.concat(parseRssItems(xml));
      await delay(DELAY_MS);
    }
    console.log(`  ${country.code}: ${items.length} items across ${country.keywords.length} keyword(s)`);

    for (const item of items) {
      if (!item.link || !item.identifier) continue;
      const pubDateIso = parsePubDate(item.pubDate);
      if (pubDateIso && pubDateIso < cutoffStr) continue;

      const filingId = `GNW-${item.identifier}`;
      if (seen.has(filingId)) continue;
      seen.add(filingId);

      await delay(DELAY_MS);
      const html = await httpsGetText(item.link);
      if (!html) { skipped++; continue; }
      fetched++;

      const text = htmlToText(html);
      const { programMax, currency, programStart, programEnd, execDate } = parseArticleBody(text, pubDateIso);

      const ticker = item.stock ? item.stock.split(':').pop() : null;
      const status = /complet/i.test(item.title || '') ? 'Completed' : 'Active';

      dbRows.push({
        filing_id:      filingId,
        country_code:   country.code,
        ticker:         ticker || '',
        company:        item.company || null,
        announced_date: programStart || pubDateIso,
        execution_date: execDate || pubDateIso,
        currency:       currency || 'EUR',
        status,
        filing_url:     item.link,
        source_url:     item.link,
        source:         SOURCE,
        shares_bought:  null,
        avg_price:      null,
        total_value:    programMax,
        program_end:    programEnd,
      });
      if (programMax || programStart || programEnd) parsed++;
    }
  }

  console.log(`  Fetched ${fetched} articles, ${parsed} with program-level detail, ${skipped} failed`);
  if (!dbRows.length) {
    console.log('  No data.');
    for (const c of COUNTRIES) await logScraperRun(c.code, 0, (Date.now()-t0)/1000, 'success');
    return { saved: 0 };
  }

  const byCc = {};
  for (const r of dbRows) byCc[r.country_code] = (byCc[r.country_code] || 0) + 1;

  const { error } = await saveBuybackPrograms(dbRows);
  if (error) {
    for (const c of COUNTRIES) await logScraperRun(c.code, 0, (Date.now()-t0)/1000, 'failed');
    console.error('  ❌ Supabase:', error.message); process.exit(1);
  }
  for (const c of COUNTRIES) await logScraperRun(c.code, byCc[c.code] || 0, (Date.now()-t0)/1000, 'success');

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} filings saved`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.company} (${r.country_code}): max=${r.total_value?.toLocaleString()||'?'} ${r.currency}, start=${r.announced_date}, end=${r.program_end||'?'}`).join('; ')}`);
  return { saved: dbRows.length };
}

scrapeGlobeNewswireBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
