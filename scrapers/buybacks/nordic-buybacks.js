'use strict';
/**
 * SE / DK / FI / IS — Share Buyback Scraper
 *
 * Source: Nasdaq Nordic — "Changes in company's own shares" (categoryId 69)
 * API:    https://api.news.eu.nasdaq.com/news/query.action  (same JSONP API used by FI/DK insider scrapers)
 * View:   https://view.news.eu.nasdaq.com/view?id=...&lang=en
 *
 * Companies file weekly or per-period execution reports under MAR Article 5.
 * The announcement body (HTML) contains:
 *
 *   Swedish / Icelandic (EQT, Attendo):
 *     ISIN: SE0012853455
 *     total maximum amount of SEK 2,500,000,000
 *     Total accumulated over week 19/2026  331,006  312.3028  103,374,112.39
 *     Total accumulated during the repurchase program  3,005,071  294.6956  885,581,100.01
 *
 *   Finnish (Raute, Alma Media):
 *     Total amount week 19  4 059  14,5319  58 984,81
 *     [Company] now holds a total of 32 117 shares
 *
 *   Danish (Gabriel Holding):
 *     [Period]  2,675  254,39  680.505
 *     Accumulated under the programme  55.109  229,67  12.657.114
 *     framework was to acquire up to 94,500 shares or for an amount of up to DKK 20 million
 *
 * One DB row saved per filing. Saves to buyback_programs table.
 */

const https = require('https');
const { saveBuybackPrograms } = require('../lib/db');
const { isinToTicker }        = require('../lib/isinToTicker');

const SOURCE         = 'Nasdaq Nordic';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const DELAY_MS       = 250;
const CNS_CATEGORY   = "Changes in company's own shares";

const MARKET_COUNTRY = {
  'Main Market, Stockholm':  'SE',
  'First North Sweden':      'SE',
  'First North Sweden Premier': 'SE',
  'Main Market, Helsinki':   'FI',
  'First North Finland':     'FI',
  'Main Market, Copenhagen': 'DK',
  'First North Denmark':     'DK',
  'Main Market, Iceland':    'IS',
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Number parsing: handles Swedish/Finnish (space=thousands, comma=decimal),
//    Danish (period=thousands, comma=decimal), English (comma=thousands, dot=decimal)
function parseNum(s) {
  if (!s && s !== 0) return null;
  const str = String(s).trim();
  if (!str || str === '-') return null;
  // Remove spaces (Scandinavian thousands separator)
  let clean = str.replace(/\s/g, '');
  // "1.234,56" → Danish: period=thousands, comma=decimal
  if (/\d\.\d{3},/.test(clean)) return parseFloat(clean.replace(/\./g, '').replace(',', '.'));
  // "1.234.567" → all-period thousands (Danish large numbers)
  if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) return parseFloat(clean.replace(/\./g, ''));
  // "1,234,567" → English comma thousands
  if (/^\d{1,3}(?:,\d{3})+$/.test(clean)) return parseFloat(clean.replace(/,/g, ''));
  // "14,5319" → comma decimal (Finnish/Danish)
  if (/,/.test(clean) && !/\./.test(clean)) return parseFloat(clean.replace(',', '.'));
  // Default: standard float
  return parseFloat(clean.replace(/,/g, ''));
}

function parseProseDate(s) {
  if (!s) return null;
  const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12 };
  // "8 May 2026" or "08.05.2026" or "2026-05-08"
  const prose = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (prose) {
    const mon = MONTHS[prose[2].toLowerCase()];
    if (mon) return `${prose[3]}-${String(mon).padStart(2,'0')}-${String(prose[1]).padStart(2,'0')}`;
  }
  const dmy = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2,'0')}-${String(dmy[1]).padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return s.trim();
  return null;
}

// ── Strip HTML tags while preserving table cell boundaries as TAB separators.
// This lets regex patterns match across cells like: "Total during week 19\t319,576\t17.61\t5,626,329"
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Table: mark row boundaries as newlines, cell boundaries as tabs
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<t[dh][^>]*>/gi, '\t')
    // Block elements → newlines
    .replace(/<\/?(p|div|h[1-6]|br|li|ul|ol|section|article|header|footer)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&[a-z]{2,6};/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    // Clean up: collapse multiple tabs/spaces on same line, remove blank lines
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/\t +/g, '\t')
    .replace(/ +\t/g, '\t')
    .replace(/\t+/g, '\t')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

// ── Parse the plain-text body of a Nordic buyback announcement
function parseBuybackText(text, pub) {
  if (!text || typeof text !== 'string') return null;

  // ── ISIN ─────────────────────────────────────────────────────────────────────
  const isinM = text.match(/\bISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})\b/i);
  const isin  = isinM ? isinM[1] : null;

  // ── Currency ─────────────────────────────────────────────────────────────────
  const CCY_RE = /\b(SEK|EUR|DKK|NOK|ISK|GBP|USD)\b/i;
  // First check near "maximum amount of CCY" or "Total cost" label
  const ccyCtx = text.match(/(?:maximum\s+amount\s+of\s+|Total\s+cost\s*\n?\s*)(SEK|EUR|DKK|NOK|ISK)/i)
               || text.match(/(?:Weighted\s+average.*?price[^\n]*)(SEK|EUR|DKK|NOK|ISK)/i)
               || text.match(CCY_RE);
  const currency = ccyCtx ? ccyCtx[1].toUpperCase() : null;

  // ── Program max authorized value ──────────────────────────────────────────────
  // "total maximum amount of SEK 2,500,000,000"
  // "for an amount of up to DKK 20 million"
  // "up to SEK 275,000,000"
  const CCY = '(SEK|EUR|DKK|NOK|ISK|GBP|USD)';
  let programMax = null;
  const prefixRe = /(?:total\s+maximum\s+amount\s+of\s+|for\s+a\s+(?:total\s+)?(?:maximum\s+)?amount\s+of\s+up\s+to\s+|up\s+to\s+(?:a\s+total\s+(?:maximum\s+)?amount\s+of\s+)?)/i;
  const maxM1 = text.match(new RegExp(prefixRe.source + CCY + '\\s*([\\d,.\\s]+)\\s*(million|billion|mn|bn)?', 'i'));
  const maxM2 = text.match(new RegExp(prefixRe.source + '([\\d,.\\s]+)\\s*(million|billion|mn|bn)?\\s*' + CCY, 'i'));
  for (const m of [maxM1, maxM2].filter(Boolean)) {
    const num = m === maxM1 ? m[2] : m[1];
    const multStr = m === maxM1 ? m[3] : m[2];
    const mult = /billion|bn/i.test(multStr||'') ? 1e9 : /million|mn/i.test(multStr||'') ? 1e6 : 1;
    const v = parseNum(num);
    if (v && v * mult > 10000) { programMax = Math.round(v * mult); break; }
  }

  // ── Program dates ─────────────────────────────────────────────────────────────
  // "runs between 7 May 2026 and 19 August 2026"
  // "runs from 4 March 2026"
  const periodM = text.match(/runs?\s+between\s+([\d\s\w]+?)\s+and\s+([\d\s\w]+\d{4})/i)
               || text.match(/runs?\s+from\s+([\d\s\w]+?\d{4})\s+(?:to|and|until)\s+([\d\s\w]+\d{4})/i);
  const programStart = periodM ? parseProseDate(periodM[1]) : null;
  const programEnd   = periodM ? parseProseDate(periodM[2]) : null;

  // ── Execution date (period end) ───────────────────────────────────────────────
  // "Between 7 May 2026 and 8 May 2026"
  // "week 19"  → use publication date
  const betweenM = text.match(/[Bb]etween\s+[\d\s\w]+\s+and\s+([\d]{1,2}\s+\w+\s+\d{4}|\d{1,2}[./]\d{1,2}[./]\d{4})/);
  let execDate = pub ? pub.slice(0, 10) : null;
  if (betweenM) { const d = parseProseDate(betweenM[1]); if (d) execDate = d; }

  // ── Period execution (this week's totals) ─────────────────────────────────────
  let sharesBought = null, avgPrice = null, weeklyValue = null;

  // Swedish / Icelandic: "Total accumulated over week 19/2026  331,006  312.3028  103,374,112.39"
  const swTotalM = text.match(/Total\s+accumulated\s+over\s+week\s+[\d\/,]+\s+([\d,. ]+?)\s+([\d.,]+)\s+([\d,. ]+)/i);
  if (swTotalM) {
    sharesBought = Math.round(parseNum(swTotalM[1]) || 0) || null;
    avgPrice     = parseNum(swTotalM[2]);
    weeklyValue  = parseNum(swTotalM[3]) ? Math.round(parseNum(swTotalM[3])) : null;
  }

  // Finnish: "Total amount week 19  4 059  14,5319  58 984,81"
  if (!sharesBought) {
    const fiTotalM = text.match(/Total\s+amount\s+week\s+\d+\s+([\d ]+)\s+([\d,]+)\s+([\d ,]+)/i);
    if (fiTotalM) {
      sharesBought = Math.round(parseNum(fiTotalM[1]) || 0) || null;
      avgPrice     = parseNum(fiTotalM[2]);
      weeklyValue  = parseNum(fiTotalM[3]) ? Math.round(parseNum(fiTotalM[3])) : null;
    }
  }

  // Danish: period row "May 2026  2,675  254,39  680.505" — appears between label rows
  if (!sharesBought) {
    // Look for a month label row followed by numbers
    const dkPeriodM = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i);
    if (dkPeriodM) {
      sharesBought = Math.round(parseNum(dkPeriodM[1]) || 0) || null;
      avgPrice     = parseNum(dkPeriodM[2]);
      weeklyValue  = parseNum(dkPeriodM[3]) ? Math.round(parseNum(dkPeriodM[3])) : null;
    }
  }

  // Kemira/table style: each cell on its own line: "Total during week 19/2026\t\n\tBuy\t\n\tKEMIRA\t\n\t319,576\t\n\t17.6056\t\n\t5,626,329.26\t"
  // Cell pattern: VALUE\t\n\t (value, tab, newline, tab-for-next-cell)
  if (!sharesBought) {
    const SEP = '\\t\\n\\t';
    // Week number may span multiple spans → "19 /2026" with space, so use [^\t\n]* to match until tab
    const kemRe = new RegExp(`Total\\s+during\\s+week\\s+[^\\t\\n]*${SEP}[^\\t\\n]*${SEP}[^\\t\\n]*${SEP}([\\d,. ]+)${SEP}([\\d.,]+)${SEP}([\\d,. ]+)\\t`, 'i');
    const kemM = text.match(kemRe);
    if (kemM) {
      sharesBought = Math.round(parseNum(kemM[1]) || 0) || null;
      avgPrice     = parseNum(kemM[2]);
      weeklyValue  = parseNum(kemM[3]) ? Math.round(parseNum(kemM[3])) : null;
    }
  }

  // Tieto daily key-value table: "Amount\t\n\t30,000\t\n" / "Average price/ share\t\n\t19.8840\t\n"
  if (!sharesBought) {
    const amtM   = text.match(/\bAmount\t\n\t([\d,. ]+)\t/i);
    const priceM = text.match(/Average\s+price[^\t\n]*\t\n\t([\d.,]+)\t/i);
    const costM  = text.match(/Total\s+cost\t\n\t([\d,. ]+)\t/i);
    if (amtM) {
      sharesBought = Math.round(parseNum(amtM[1]) || 0) || null;
      if (priceM) avgPrice = parseNum(priceM[1]);
      if (costM)  weeklyValue = parseNum(costM[1]) ? Math.round(parseNum(costM[1])) : null;
    }
  }

  // Generic tab-cell fallback: row with "Total" label followed by 3 numeric cells (possibly on separate lines)
  if (!sharesBought) {
    const genTab = text.match(/\bTotal\b[^\n]*\t\n\t([\d,. ]+)\t\n\t([\d.,]+)\t\n\t([\d,. ]+)\t/i);
    if (genTab) {
      sharesBought = Math.round(parseNum(genTab[1]) || 0) || null;
      avgPrice     = parseNum(genTab[2]);
      weeklyValue  = parseNum(genTab[3]) ? Math.round(parseNum(genTab[3])) : null;
    }
  }

  // Validate: avgPrice shouldn't exceed share count
  if (sharesBought && avgPrice && avgPrice > sharesBought) {
    // Re-round after swap: shares_bought is bigint in DB, must be integer
    [sharesBought, avgPrice] = [Math.round(avgPrice), sharesBought];
  }

  // ── Cumulative totals ─────────────────────────────────────────────────────────
  let cumShares = null, cumValue = null;

  // "Total accumulated during the repurchase program  3,005,071  294.6956  885,581,100.01"
  const swCumM = text.match(/Total\s+accumulated\s+during\s+(?:the\s+)?(?:repurchase\s+)?program\w*\s+([\d,. ]+?)\s+([\d.,]+)\s+([\d,. ]+)/i);
  if (swCumM) {
    cumShares = Math.round(parseNum(swCumM[1]) || 0) || null;
    cumValue  = parseNum(swCumM[3]) ? Math.round(parseNum(swCumM[3])) : null;
  }

  // "Accumulated under the programme  55.109  229,67  12.657.114"
  if (!cumShares) {
    const dkCumM = text.match(/Accumulated\s+under\s+(?:the\s+)?programme?\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/i);
    if (dkCumM) {
      cumShares = Math.round(parseNum(dkCumM[1]) || 0) || null;
      cumValue  = parseNum(dkCumM[3]) ? Math.round(parseNum(dkCumM[3])) : null;
    }
  }

  // ── Completion % ──────────────────────────────────────────────────────────────
  let completionPct = null;
  if (cumValue && programMax && programMax > 0) {
    completionPct = Math.round((cumValue / programMax) * 1000) / 10;
  }
  if (completionPct === null) {
    const pctM = text.match(/(?:finalized|completed|program\s+has\s+been\s+finalized)/i);
    if (pctM) completionPct = 100;
  }

  if (!sharesBought && !weeklyValue && !programMax) return null;

  return {
    isin,
    currency: currency || (isin ? isin.slice(0, 2) === 'SE' ? 'SEK' : isin.slice(0, 2) === 'FI' ? 'EUR' : isin.slice(0, 2) === 'DK' ? 'DKK' : null : null),
    shares_bought:     sharesBought,
    avg_price:         avgPrice,
    weekly_value:      weeklyValue,
    program_max:       programMax,
    program_start:     programStart,
    program_end:       programEnd,
    cumulative_shares: cumShares,
    cumulative_value:  cumValue,
    completion_pct:    completionPct,
    execution_date:    execDate,
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpsGet(hostname, path, headers = {}) {
  return new Promise(resolve => {
    const req = https.get({
      hostname, path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    }, res => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        const loc = res.headers.location;
        const target = loc.startsWith('http') ? new URL(loc) : new URL(`https://${hostname}${loc}`);
        return resolve(httpsGet(target.hostname, target.pathname + target.search, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchNasdaqList(fromDate, toDate, start) {
  const qs = new URLSearchParams({
    countResults:   'true',
    globalGroup:    'exchangeNotice',
    displayLanguage:'en',
    timeZone:       'CET',
    dateMask:       'yyyy-MM-dd HH:mm:ss',
    limit:          '200',
    start:          String(start),
    dir:            'DESC',
    globalName:     'NordicAllMarkets',
    cnsCategory:    CNS_CATEGORY,
    fromDate,
    toDate,
    callback:       'handleResponse',
  }).toString();

  const res = await httpsGet('api.news.eu.nasdaq.com', `/news/query.action?${qs}`);
  if (!res || res.status !== 200) return null;

  let body = res.body.trim();
  if (body.startsWith('handleResponse(')) {
    body = body.slice('handleResponse('.length);
    if (body.endsWith(')')) body = body.slice(0, -1);
  }
  try { return JSON.parse(body); } catch { return null; }
}

async function fetchAnnouncementText(messageUrl) {
  try {
    const u = new URL(messageUrl);
    const res = await httpsGet(u.hostname, u.pathname + u.search, { Accept: 'text/html' });
    if (!res || res.status !== 200) return null;
    return stripHtml(res.body);
  } catch { return null; }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function scrapeNordicBuybacks() {
  console.log('🇸🇪🇩🇰🇫🇮  Nasdaq Nordic — Share Buyback Programs ("Changes in company\'s own shares")');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  // ── Paginate through list ──────────────────────────────────────────────────
  const allItems = [];
  let start = 0;
  while (true) {
    const data = await fetchNasdaqList(from, to, start);
    if (!data) { console.warn('  ⚠  API error at start=' + start); break; }
    const items = data?.results?.item || [];
    if (!items.length) break;
    allItems.push(...items);
    // Stop if last item is older than our window (API returns unbounded when paginating)
    const lastPub = items[items.length - 1]?.published || '';
    if (lastPub < from || items.length < 200) break;
    start += 200;
    await delay(DELAY_MS);
  }

  console.log(`  Found ${allItems.length} filings`);
  if (!allItems.length) { console.log('  No data.'); return { saved: 0 }; }

  // ── Process each filing ────────────────────────────────────────────────────
  const seen   = new Set();
  const dbRows = [];
  let   parsed = 0, skipped = 0;

  // Deduplicate: skip duplicate-language posts (English preferred)
  // Nasdaq Nordic often posts both English and local language versions with the same content
  const seenCompanyDate = new Set();

  for (const item of allItems) {
    const countryCode = MARKET_COUNTRY[item.market];
    if (!countryCode) continue;

    // Prefer English announcements; skip local-language duplicates for same company+date
    const dedupKey = `${item.company}|${(item.published || '').slice(0, 10)}`;
    if (seenCompanyDate.has(dedupKey) && item.language !== 'en') continue;
    if (item.language === 'en') seenCompanyDate.add(dedupKey);

    const filingId = `NORDIC-BUY-${item.disclosureId}`;
    if (seen.has(filingId)) continue;
    seen.add(filingId);

    const text = await fetchAnnouncementText(item.messageUrl);
    await delay(DELAY_MS);
    if (!text) { skipped++; continue; }

    const result = parseBuybackText(text, item.published);
    if (!result) { skipped++; continue; }

    // Currency fallback by country if not found in text
    const ccy = result.currency || { SE: 'SEK', FI: 'EUR', DK: 'DKK', IS: 'ISK' }[countryCode] || null;

    parsed++;
    const execDate = result.execution_date || (item.published || '').slice(0, 10);

    const row = {
      filing_id:      filingId,
      country_code:   countryCode,
      company:        item.company || null,
      announced_date: result.program_start || execDate,
      execution_date: execDate,
      shares_bought:  result.shares_bought,
      avg_price:      result.avg_price,
      currency:       ccy,
      status:         result.completion_pct != null && result.completion_pct >= 95 ? 'Completed' : 'Active',
      filing_url:     item.messageUrl,
      source_url:     item.messageUrl,
      source:         SOURCE,
      total_value:    result.program_max || null,
    };

    if (result.cumulative_value != null)  { row.spent_value = result.cumulative_value; row.cumulative_value = result.cumulative_value; }
    if (result.cumulative_shares != null) row.cumulative_shares  = result.cumulative_shares;
    if (result.completion_pct != null)    { row.completion_pct = result.completion_pct; row.pct_complete = Math.round(result.completion_pct); }
    if (result.program_start != null)     row.announced_date     = result.program_start;

    // Ticker from ISIN (isin column not in buyback_programs — use only for lookup)
    if (result.isin) {
      try {
        const ticker = await isinToTicker(result.isin);
        if (ticker) row.ticker = ticker;
      } catch {}
    }

    dbRows.push(row);
  }

  console.log(`  Parsed: ${parsed}, Skipped (no data): ${skipped}`);
  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const byCc = {};
  for (const r of dbRows) byCc[r.country_code] = (byCc[r.country_code] || 0) + 1;
  console.log('  By country:', Object.entries(byCc).map(([k,v]) => `${k}: ${v}`).join(', '));

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  const withMax  = dbRows.filter(r => r.total_value).length;
  const withCum  = dbRows.filter(r => r.cumulative_value).length;
  console.log(`  Program max extracted: ${withMax}, Cumulative totals: ${withCum}`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r =>
    `${r.company} (${r.country_code}): ${r.shares_bought?.toLocaleString()} shares @ ${r.avg_price} ${r.currency}`
  ).join('; ')}`);

  return { saved: dbRows.length };
}

scrapeNordicBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
