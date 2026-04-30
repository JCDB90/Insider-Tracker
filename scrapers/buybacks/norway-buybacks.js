'use strict';
/**
 * NO — Share Buyback Scraper
 *
 * Source: Oslo Bors / Euronext Oslo — NewsWeb (api3.oslo.oslobors.no)
 * Category: 1007 — "Acquisition or Disposal of an Issuer's Own Shares"
 *
 * Companies file daily or weekly buyback execution reports as plain-text
 * announcements with ASCII tables:
 *
 *   +----------+-------+-------------------+-------------------+
 *   | Trading  |Number | Weighted average  |Total cost, EUR    |
 *   | venue    |shares |price / share, EUR |                   |
 *   +----------+-------+-------------------+-------------------+
 *   |XHEL      |233,667|15.69              |3,666,819.40       |
 *   |Total     |425,142|15.68              |6,665,154.53       |
 *   +----------+-------+-------------------+-------------------+
 *
 * We parse the Total row for aggregate shares, avg price, total value.
 * One DB row saved per filing (one per company per day/week).
 */

const https   = require('https');
const { saveBuybackPrograms } = require('../lib/db');

const COUNTRY_CODE   = 'NO';
const SOURCE         = 'Oslo Bors / Euronext Oslo';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const BUYBACK_CAT_ID = 1007;
const NEWSWEB_BASE   = 'https://newsweb.oslobors.no';
const API_BASE       = 'https://api3.oslo.oslobors.no';
const DELAY_MS       = 300;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function parseNum(s) {
  if (!s && s !== 0) return null;
  const str = String(s).trim().replace(/\s/g, '');
  if (!str) return null;
  if (/\d\.\d{3},\d/.test(str)) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+$/.test(str)) return parseFloat(str.replace(/\./g, ''));
  if (/\d,\d{3}\./.test(str)) return parseFloat(str.replace(/,/g, ''));
  if (/,/.test(str) && !/\./.test(str)) {
    const parts = str.split(',');
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) return parseFloat(str.replace(/,/g, ''));
    return parseFloat(str.replace(',', '.'));
  }
  return parseFloat(str);
}

const HEADERS = {
  'Accept': 'application/json',
  'Origin': NEWSWEB_BASE,
  'Referer': `${NEWSWEB_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function getJson(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: HEADERS }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Date helpers ──────────────────────────────────────────────────────────────

const MO_MAP = { january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12 };

function parseProseDate(s) {
  if (!s) return null;
  // "3 March 2026" or "27 May 2026"
  const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) {
    const mon = MO_MAP[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  // "10.04.2026" or "4/13/2026"
  const d2 = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (d2) return `${d2[3]}-${String(d2[2]).padStart(2,'0')}-${String(d2[1]).padStart(2,'0')}`;
  return null;
}

// ── Parse buyback message body ────────────────────────────────────────────────
//
// Handles three main formats found on Oslo Bors:
//
//  A) LINK Mobility / weekly summary with 4-col pipe table:
//     |Date | Shares | Avg price (NOK) | Total value (NOK)|
//     |Period Total | 1,750,000 | 23.59 | 41,288,800|
//     |Previously disclosed buybacks | 7,850,000 | 22.00 | 172,765,850|
//     |Accumulated under the buyback program | 9,600,000 | 22.30 | 214,054,650|
//     + prose: "total consideration of up to NOK 300 million"
//
//  B) Nordea / simple 4-col pipe table:
//     |XHEL |233,667|15.69|3,666,819.40|  → |Total|425,142|15.68|6,665,154.53|
//
//  C) Tieto/Helsinki / space-separated:
//     "Total   51 800   15.78"

function parseBuybackBody(body, issuerName, issuerSign, msgDate) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/\r\n?/g, '\n');

  // ── Currency ──────────────────────────────────────────────────────────────
  const currM = text.match(/Total\s+(?:cost|transactions?\s+value)[,\s]+([A-Z]{3})/i)
             || text.match(/(?:value|price|kurs)[,\s(]+([A-Z]{3})[),\s]/i)
             || text.match(/\b(NOK|EUR|USD|GBP|SEK|DKK|CHF)\b/);
  const currency = currM ? currM[1].toUpperCase() : 'NOK';

  // ── Program authorization (max VALUE, not share count) ────────────────────
  // "total consideration of up to NOK 300 million"
  // "repurchase shares for a total consideration of up to NOK 100,000,000"
  // Requires an explicit currency code to distinguish value from share count.
  let programMax = null;
  const maxM = text.match(/(?:total\s+consideration\s+of\s+up\s+to|up\s+to\s+(?:a\s+total\s+(?:consideration\s+)?of\s+)?|repurchase\s+(?:shares\s+)?for\s+(?:a\s+total\s+(?:consideration\s+)?of\s+)?)\s*(NOK|EUR|USD|GBP|SEK|DKK|CHF)\s*([\d,. ]+)\s*(million|billion|mn|bn)?/i);
  if (maxM) {
    const mult = /billion|bn/i.test(maxM[3]||'') ? 1e9 : /million|mn/i.test(maxM[3]||'') ? 1e6 : 1;
    const v = parseNum(maxM[2]);
    if (v) programMax = Math.round(v * mult);
  }

  // ── Program dates ──────────────────────────────────────────────────────────
  // "program commenced on 3 March 2026"
  const startM = text.match(/(?:program(?:me)?\s+commenced\s+on|commencing\s+on|start(?:ing)?\s+(?:date|on))\s+(\d{1,2}\s+\w+\s+\d{4}|\d{1,2}[./]\d{1,2}[./]\d{4})/i);
  const programStart = startM ? parseProseDate(startM[1]) : null;

  // "will run until no later than the Company's Annual General Meeting on 27 May 2026"
  // "no later than [date]" / "until [date]"
  const endM = text.match(/(?:no\s+later\s+than|until|expire|end(?:ing)?(?:\s+(?:on|date))?)\s+(?:the\s+Company['']?s?\s+Annual\s+General\s+Meeting\s+on\s+)?(\d{1,2}\s+\w+\s+\d{4})/i);
  const programEnd = endM ? parseProseDate(endM[1]) : null;

  // ── Accumulated / cumulative row ───────────────────────────────────────────
  // |Accumulated under the buyback program | 9,600,000 | 22.2974 | 214,054,650|
  // Note: Oslo Bors sometimes splits cell text across multiple lines:
  // |Accumulated under   |              |              |              |
  // |the buyback         | 9,600,000    | 22.2974      | 214,054,650  |
  // |program             |              |              |              |
  // → normalise by collapsing consecutive pipe-rows into one before matching.
  const normText = text.replace(/\|\s*\n\s*\|/g, '| ');  // join broken pipe rows
  let cumShares = null, cumValue = null;
  const accumM = normText.match(/\|\s*Accumulated[^|]*?\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/i);
  if (accumM) {
    cumShares = Math.round(parseNum(accumM[1]) || 0) || null;
    cumValue  = parseNum(accumM[3]) ? Math.round(parseNum(accumM[3])) : null;
  }

  // ── Period Total row (this week's execution) ───────────────────────────────
  // |Period Total | 1,750,000 | 23.5936 | 41,288,800|
  let sharesBought = null, avgPrice = null, weeklyValue = null;
  const periodM = normText.match(/\|\s*Period\s+Total\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/i);
  if (periodM) {
    sharesBought = Math.round(parseNum(periodM[1]) || 0) || null;
    avgPrice     = parseNum(periodM[2]);
    weeklyValue  = parseNum(periodM[3]) ? Math.round(parseNum(periodM[3])) : null;
  }

  // ── Fallback: simple |Total| row (Nordea format) ──────────────────────────
  if (!sharesBought) {
    const simpleTotal = normText.match(/\|\s*Total\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/i);
    if (simpleTotal) {
      sharesBought = Math.round(parseNum(simpleTotal[1]) || 0) || null;
      avgPrice     = parseNum(simpleTotal[2]);
      weeklyValue  = parseNum(simpleTotal[3]) ? Math.round(parseNum(simpleTotal[3])) : null;
    }
  }

  // ── Fallback: Tieto space-table ────────────────────────────────────────────
  if (!sharesBought) {
    const spaceTotal = text.match(/^Total\s+([\d ,]+)\s+([\d.,]+)/im)
                    || text.match(/\bTotal\b\s+([\d ,]+)\s+([\d.,]+)/im);
    if (spaceTotal) {
      sharesBought = Math.round(parseNum(spaceTotal[1]) || 0) || null;
      avgPrice     = parseNum(spaceTotal[2]);
      weeklyValue  = (sharesBought && avgPrice) ? Math.round(sharesBought * avgPrice) : null;
    }
  }

  // ── Fallback: prose "X shares at NOK Y" ───────────────────────────────────
  if (!sharesBought) {
    const proseS = text.match(/([\d,. ]+)\s+(?:own\s+)?shares?\s+(?:at|for|@)/i);
    const proseP = text.match(/average\s+price\s+of\s+(?:NOK|EUR|GBP|USD)?\s*([\d.,]+)/i)
                || text.match(/(?:at|price\s+of)\s+(?:NOK|EUR|GBP|USD)?\s*([\d.,]+)\s*per\s+share/i);
    if (proseS) sharesBought = Math.round(parseNum(proseS[1]) || 0) || null;
    if (proseP) avgPrice = parseNum(proseP[1]);
    if (sharesBought && avgPrice) weeklyValue = Math.round(sharesBought * avgPrice);
  }

  // ── Pipe-table row sum fallback (individual venue rows) ───────────────────
  if (!sharesBought) {
    const rowRe = /\|\s*[A-Z0-9\-]{2,6}\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|\s*([\d,. ]+?)\s*\|/g;
    let ts = 0, tc = 0, cnt = 0, m;
    while ((m = rowRe.exec(text)) !== null) {
      const s = parseNum(m[1]), c = parseNum(m[3]);
      if (s && c && s < 1e8 && c < 1e12) { ts += s; tc += c; cnt++; }
    }
    if (cnt > 0) {
      sharesBought = Math.round(ts);
      weeklyValue  = Math.round(tc);
      avgPrice     = ts > 0 ? Math.round((tc / ts) * 10000) / 10000 : null;
    }
  }

  // ── Execution date ─────────────────────────────────────────────────────────
  // "For the period from 13 April to 17 April 2026" → use end date
  // "on 24.4.2026" → direct date
  let execDate = msgDate;
  const periodDates = text.match(/period\s+from\s+[\d\s\w]+\s+to\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)/i)
                   || text.match(/period\s+from\s+.*?to\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
  if (periodDates) {
    let d = parseProseDate(periodDates[1]);
    // If year missing, assume current year
    if (d && d.length < 10) d = new Date().getFullYear() + '-' + d;
    if (d) execDate = d;
  }
  if (execDate === msgDate) {
    // "on 24.4.2026" or "Trade date 23.4.2026"
    const singleDate = text.match(/(?:trade\s+date|on)\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/i)
                    || text.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
    if (singleDate) { const d = parseProseDate(singleDate[1]); if (d) execDate = d; }
  }

  // ── Completion % ──────────────────────────────────────────────────────────
  // Derive from cumulative / programMax, or parse prose
  let completionPct = null;
  if (cumValue && programMax && programMax > 0) {
    completionPct = Math.round((cumValue / programMax) * 1000) / 10; // 1 decimal
  } else {
    const pctM = text.match(/([\d.]+)\s*%\s+of\s+the\s+(?:maximum|total)/i);
    if (pctM) completionPct = parseFloat(pctM[1]);
  }

  if (!sharesBought && !weeklyValue && !programMax) return null;

  return {
    currency,
    shares_bought:    sharesBought,
    avg_price:        avgPrice,
    weekly_value:     weeklyValue,      // this period's execution value
    program_max:      programMax,       // authorized programme size
    program_start:    programStart,
    program_end:      programEnd,
    cumulative_shares: cumShares,
    cumulative_value:  cumValue,
    completion_pct:   completionPct,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeNOBuybacks() {
  console.log('🇳🇴  Oslo Bors — Share Buyback Programs (category 1007)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const listData = await getJson(
    `${API_BASE}/v1/newsreader/list?category=${BUYBACK_CAT_ID}&fromDate=${from}&toDate=${to}`
  );

  const messages = listData?.data?.messages || [];
  console.log(`  Found ${messages.length} buyback filings`);

  if (!messages.length) { console.log('  No data.'); return { saved: 0 }; }

  const seen   = new Set();
  const dbRows = [];
  let   parsed = 0, skipped = 0;

  for (const msg of messages) {
    const msgId   = msg.messageId;
    const filingId = `NO-BUY-${msgId}`;
    if (seen.has(filingId)) continue;
    seen.add(filingId);

    // Fetch message body
    const detail = await getJson(
      `${API_BASE}/v1/newsreader/message?messageId=${msgId}`
    );
    await delay(DELAY_MS);

    const body    = detail?.data?.message?.body || '';
    const msgDate = (msg.publishedTime || '').slice(0, 10);
    const result  = parseBuybackBody(body, msg.issuerName, msg.issuerSign, msgDate);

    if (!result) { skipped++; continue; }

    parsed++;
    const execDate = result.execution_date || msgDate;
    const row = {
      filing_id:      filingId,
      country_code:   COUNTRY_CODE,
      ticker:         msg.issuerSign || null,
      company:        msg.issuerName || null,
      announced_date: result.program_start || execDate,
      execution_date: execDate,
      shares_bought:  result.shares_bought,
      avg_price:      result.avg_price,
      currency:       result.currency,
      status:         result.completion_pct >= 95 ? 'Completed' : 'Active',
      filing_url:     `${NEWSWEB_BASE}/message/${msgId}`,
      source_url:     `${NEWSWEB_BASE}/message/${msgId}`,
      source:         SOURCE,
    };
    // total_value always written (even null) so bad extractions get cleared on re-run
    // total_value always written so bad extractions get cleared on re-run
    row.total_value = result.program_max || null;
    if (result.cumulative_value != null) { row.spent_value = result.cumulative_value; row.cumulative_value = result.cumulative_value; }
    if (result.cumulative_shares!= null) row.cumulative_shares = result.cumulative_shares;
    if (result.completion_pct   != null) { row.completion_pct = result.completion_pct; row.pct_complete = Math.round(result.completion_pct); }
    if (result.program_start    != null) row.announced_date    = result.program_start;
    dbRows.push(row);
  }

  console.log(`  Parsed: ${parsed}, Skipped (no data): ${skipped}`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  const withMax = dbRows.filter(r=>r.total_value).length;
  const withCum = dbRows.filter(r=>r.cumulative_value).length;
  console.log(`  Program max extracted: ${withMax}, Cumulative totals: ${withCum}`);
  console.log(`  Sample: ${dbRows.slice(0,2).map(r=>`${r.company}: ${r.shares_bought?.toLocaleString()} shares, cumulative ${r.cumulative_value?.toLocaleString()} ${r.currency}${r.completion_pct ? ' ('+r.completion_pct+'%)' : ''}`).join('; ')}`);
  return { saved: dbRows.length };
}

scrapeNOBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
