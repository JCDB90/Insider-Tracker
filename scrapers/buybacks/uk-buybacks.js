'use strict';
/**
 * GB — Share Buyback Scraper
 *
 * Source: FCA National Storage Mechanism (NSM)
 * API: POST https://api.data.fca.org.uk/search?index=fca-nsm-searchdata
 * Keyword: "buyback" in headline
 *
 * Companies file weekly MAR Article 5 buyback reports (HTML documents).
 * Each document covers one reporting period (typically a week) per company.
 *
 * Document text format (after stripping HTML):
 *   Date    Security  Transaction  Trading venue  Number of shares  Weighted avg price
 *   16/04/2026  SAN  Purchase  XMAD  1,000  10.6232
 *   ...
 *   TOTAL   11,994,505
 *
 *   Issuer name: Banco Santander, S.A.
 *   ISIN: ES0113900J37
 *   56.3% of the maximum investment amount   ← program completion
 */

const https   = require('https');
const { saveBuybackPrograms } = require('../lib/db');

const COUNTRY_CODE   = 'GB';
const SOURCE         = 'FCA NSM';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const FCA_API        = 'https://api.data.fca.org.uk';
const FCA_DATA       = 'https://data.fca.org.uk';
const PAGE_SIZE      = 100;
const DELAY_MS       = 200;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function parseNum(s) {
  if (!s && s !== 0) return null;
  const str = String(s).trim().replace(/,/g, '').replace(/\s/g, '');
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

function postJson(path, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: FCA_API.replace('https://', ''),
      path,
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function getHtml(path) {
  return new Promise(resolve => {
    const req = https.get({
      hostname: FCA_DATA.replace('https://', ''),
      path,
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'text/html' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

// ── HTML → plain text ─────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  // Remove style/script blocks
  let t = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  // Replace block elements with newlines
  t = t.replace(/<\/(?:tr|p|div|br|li|h[1-6])[^>]*>/gi, '\n');
  // Replace cell separators with spaces
  t = t.replace(/<\/(?:td|th)[^>]*>/gi, ' ');
  // Strip remaining tags
  t = t.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Collapse whitespace
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// ── Parse buyback document text ───────────────────────────────────────────────

function parseUKBuybackDoc(text, meta) {
  if (!text) return null;

  // ── Company name ──────────────────────────────────────────────────────────
  const issuerM = text.match(/Issuer\s+name\s*[:\-]\s*([^\n]{3,80})/i);
  let company = (issuerM ? issuerM[1].trim() : meta.company) || null;
  // Strip LEI code appended to company name: "Banco Santander - LEI XXXX" → "Banco Santander"
  if (company) company = company.replace(/\s*-?\s*LEI\s+[A-Z0-9]{18,20}/i, '').trim();

  // ── ISIN ──────────────────────────────────────────────────────────────────
  const isinM = text.match(/(?:ISIN|Code\s+ISIN)[:\s]+([A-Z]{2}[A-Z0-9]{10})/i);
  const isin  = isinM ? isinM[1] : null;

  // ── Currency ──────────────────────────────────────────────────────────────
  const currM = text.match(/Weighted\s+average\s+price\s*\(([€£$]|[A-Z]{3})\)/i)
             || text.match(/(?:spend|maximum|up to)\s+of\s+([€£$])/i)
             || text.match(/\b(GBP|EUR|USD|SEK|NOK|DKK|CHF)\b/);
  let currency = 'GBP';
  if (currM) {
    const symMap = { '€': 'EUR', '£': 'GBP', '$': 'USD' };
    currency = symMap[currM[1]] || currM[1];
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TYPE A — EXECUTION REPORT: has a data table with dates and TOTAL row
  // ════════════════════════════════════════════════════════════════════════════

  const totalRowM = text.match(/\bTOTAL\b[\s\t]+([\d,]+)/i);
  let sharesBought = null, avgPrice = null, totalValue = null, execDate = null, completionPct = null;

  if (totalRowM) {
    sharesBought = Math.round(parseNum(totalRowM[1]) || 0) || null;

    // Weighted avg from rows: "DD/MM/YYYY  TICKER  Purchase  VENUE  shares  price"
    const rowRe = /(\d{2}\/\d{2}\/\d{4})\s+\S+\s+Purchase\s+\S+\s+([\d,]+)\s+([\d.]+)/gi;
    let wSum = 0, wShares = 0, m;
    while ((m = rowRe.exec(text)) !== null) {
      const s = parseNum(m[2]), p = parseNum(m[3]);
      if (s && p) { wSum += s * p; wShares += s; }
    }
    avgPrice   = wShares > 0 ? Math.round((wSum / wShares) * 10000) / 10000 : null;
    totalValue = (sharesBought && avgPrice) ? Math.round(sharesBought * avgPrice) : null;

    // Execution date = last date in the data rows
    const allDates = [...text.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)]
      .map(([, dd, mm, yyyy]) => `${yyyy}-${mm}-${dd}`)
      .filter(d => d >= '2020-01-01')
      .sort();
    execDate = allDates.length ? allDates[allDates.length - 1] : meta.submittedDate?.slice(0, 10);

    const pctM = text.match(/([\d.]+)\s*%\s+of\s+the\s+maximum/i);
    if (pctM) completionPct = parseFloat(pctM[1]);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TYPE B — PROGRAMME ANNOUNCEMENT: "up to £300 million" / "spend of £350 million"
  // ════════════════════════════════════════════════════════════════════════════

  let programMaxValue = null, programCurrency = currency, programStart = null, programEnd = null;

  // "a share buyback programme of up to £300 million"
  // "a spend in this period of £350 million"
  // "maximum aggregate market value equivalent to £200 million"
  const progValueM = text.match(/(?:up\s+to\s+(?:a\s+maximum\s+(?:aggregate\s+market\s+value\s+equivalent\s+to\s+)?of\s+)?|spend\s+(?:in\s+this\s+period\s+)?of\s+|programme\s+of\s+up\s+to\s+|maximum\s+of\s+)([€£$])?([\d,.]+)\s*(million|billion|mn|bn)\b/i);
  if (progValueM) {
    const sym   = progValueM[1] || '';
    const symMap = { '€': 'EUR', '£': 'GBP', '$': 'USD' };
    programCurrency = symMap[sym] || currency;
    const mult = /billion|bn/i.test(progValueM[3]) ? 1e9 : 1e6;
    programMaxValue = Math.round(parseNum(progValueM[2]) * mult);
  }

  // "Programme will commence on 24 April 2026 and will end on or before the 27 February 2027"
  const startM = text.match(/(?:commence|begin|start)\s+on\s+(\d{1,2}\s+\w+ \d{4})/i);
  const endM   = text.match(/(?:end\s+(?:on|before|by)|no\s+later\s+than)\s+(?:or\s+before\s+)?(\d{1,2}\s+\w+\s+\d{4})/i);
  const mo = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

  function parseProseDate(s) {
    if (!s) return null;
    const m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (!m) return null;
    const mon = mo[m[2].toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  if (startM) programStart = parseProseDate(startM[1]);
  if (endM)   programEnd   = parseProseDate(endM[1]);

  // ── Cumulative spent from execution reports ───────────────────────────────
  // "cash amount... amounts to 2,829,295,540 Euros" (cumulative to date)
  let spentValue = null;
  const spentM = text.match(/cash\s+amount[^.]*?amounts?\s+to\s+([\d,]+(?:\.\d+)?)\s*(?:[A-Z]{3}|Euros?|Pounds?|dollars?)/i)
              || text.match(/total\s+consideration[^.]*?amounts?\s+to\s+([\d,]+(?:\.\d+)?)/i);
  if (spentM) spentValue = Math.round(parseNum(spentM[1]));

  // Derive programme max from spent + completion %:
  // "2,829,295,540 represents approximately 56.3% of the maximum"  → max = spent / 0.563
  let derivedMax = null;
  if (spentValue && completionPct && completionPct > 0) {
    derivedMax = Math.round(spentValue / (completionPct / 100));
  }
  // Use explicit announcement value if available, else derived
  const effectiveMax = programMaxValue || derivedMax || null;

  // Decide result type
  const hasExecution    = !!sharesBought;
  const hasAnnouncement = !!effectiveMax;

  if (!hasExecution && !hasAnnouncement) return null;

  return {
    company,
    isin,
    currency:          hasExecution ? currency : programCurrency,
    // weekly execution fields
    shares_bought:     sharesBought,
    avg_price:         avgPrice,
    weekly_value:      totalValue,       // this period's execution value (not stored directly in total_value)
    // programme-level fields (same column semantics as norway scraper)
    total_value:       effectiveMax,     // programme max authorised
    spent_value:       spentValue,       // cumulative spent
    execution_date:    execDate || meta.submittedDate?.slice(0, 10),
    completion_pct:    completionPct,
    status:            hasExecution ? 'Active' : 'Announced',
    program_start:     programStart,
    program_end:       programEnd,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeGBBuybacks() {
  console.log('🇬🇧  FCA NSM — Share Buyback Programs');
  const t0       = Date.now();
  const cutoffDate = cutoff();
  const fromStr  = cutoffDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const toStr    = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`  Range: ${fromStr.slice(0,10)} → ${toStr.slice(0,10)}`);

  // Step 1: search FCA NSM for buyback documents
  let allHits = [];
  let from = 0, total = null;

  while (true) {
    const res = await postJson('/search?index=fca-nsm-searchdata', {
      from,
      size: PAGE_SIZE,
      sort: 'submitted_date',
      sortorder: 'desc',
      criteriaObj: {
        criteria: [{ name: 'headline', value: 'buyback' }],
        dateCriteria: [{ name: 'submitted_date', value: { from: fromStr, to: toStr } }],
      },
    });

    if (!res?.hits) break;
    const hits = res.hits.hits || [];
    if (total === null) total = res.hits.total?.value || 0;
    if (!hits.length) break;
    allHits = allHits.concat(hits);
    from += hits.length;
    if (from >= total) break;
    await delay(150);
  }

  console.log(`  Found ${total} buyback filings, processing ${allHits.length}`);
  if (!allHits.length) { console.log('  No data.'); return { saved: 0 }; }

  // Step 2: fetch and parse each document
  const seen   = new Set();
  const dbRows = [];
  let   parsed = 0, skipped = 0;

  for (const hit of allHits) {
    const id       = hit._id;
    const src      = hit._source || {};
    const filingId = `GB-BUY-${id}`;
    if (seen.has(filingId)) continue;
    seen.add(filingId);

    const downloadLink = src.download_link || '';
    if (!downloadLink) { skipped++; continue; }

    // Fetch HTML document
    const html = await getHtml(`/artefacts/${downloadLink}`);
    await delay(DELAY_MS);

    if (!html) { skipped++; continue; }

    const text   = htmlToText(html);
    const result = parseUKBuybackDoc(text, {
      company:       src.company || null,
      submittedDate: src.submitted_date || null,
    });

    if (!result) { skipped++; continue; }

    parsed++;
    const fileUrl = `https://data.fca.org.uk/artefacts/${downloadLink}`;
    // Base row — always present fields
    const row = {
      filing_id:      filingId,
      country_code:   COUNTRY_CODE,
      ticker:         '',
      company:        result.company || src.company || null,
      announced_date: result.program_start || result.execution_date || src.submitted_date?.slice(0, 10),
      execution_date: result.execution_date,
      shares_bought:  result.shares_bought,
      avg_price:      result.avg_price,
      currency:       result.currency,
      status:         result.status || 'Active',
      filing_url:     fileUrl,
      source_url:     fileUrl,
      source:         SOURCE,
    };
    // Only include enriched fields when non-null — preserves existing DB values
    // when a document lacks cumulative/programme data (avoids null overwrites)
    if (result.total_value    != null) row.total_value    = result.total_value;
    if (result.spent_value    != null) { row.spent_value = result.spent_value; row.cumulative_value = result.spent_value; }
    if (result.completion_pct != null) { row.completion_pct = result.completion_pct; row.pct_complete = Math.round(result.completion_pct); }
    if (result.program_end    != null) row.program_end    = result.program_end;
    dbRows.push(row);
  }

  console.log(`  Parsed: ${parsed}, Skipped: ${skipped}`);

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { inserted, error } = await saveBuybackPrograms(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved`);
  console.log(`  Sample: ${dbRows.slice(0,3).map(r=>`${r.company} ${r.shares_bought?.toLocaleString()} @ ${r.avg_price}`).join('; ')}`);
  return { saved: dbRows.length };
}

scrapeGBBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
