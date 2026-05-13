'use strict';
/**
 * Buyback Program Enrichment
 *
 * Fetches the source announcement for each buyback program and extracts:
 *   - program_start → overwrites announced_date (was incorrectly set to execution_date)
 *   - program_end   → new column (requires migrations/005_buyback_program_end.sql)
 *   - total_value   → program max authorization amount (fills nulls)
 *   - completion_pct→ derived from cumulative_value / total_value
 *
 * Supported markets: SE, DK, FI, IS (Nasdaq Nordic HTML pages)
 *                    NO (Oslo Bors newsreader JSON API)
 *
 * Run: node scrapers/buybacks/enrich-buybacks.js
 * Or for a specific country: COUNTRY=SE node scrapers/buybacks/enrich-buybacks.js
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const DELAY_MS       = 300;
const ONLY_COUNTRY   = process.env.COUNTRY || null;
const NORDICS        = new Set(['SE', 'DK', 'FI', 'IS']);
const OSLO_API_BASE  = 'https://api3.oslo.oslobors.no';

const MONTHS = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Date parsing ──────────────────────────────────────────────────────────────

function parseDate(s) {
  if (!s) return null;
  s = s.trim().replace(/,/g, '').replace(/\s+/g, ' ');
  // "7 May 2026" or "24 April 2026"
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  // "April 24 2026" or "April 24, 2026"
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${String(mon).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  // "2026-05-07"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // "07.05.2026" or "07/05/2026"
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

// ── Text parsing ──────────────────────────────────────────────────────────────

const DATE_TOKEN = String.raw`(\d{1,2}\s+[A-Za-z]+(?:,?\s+\d{4})?|[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})`;

function parseProgramDates(text) {
  if (!text) return { start: null, end: null };

  const d = DATE_TOKEN;

  // "runs between {start} and {end}"
  let m = text.match(new RegExp(`runs?\\s+between\\s+${d}\\s+and\\s+${d}`, 'i'));
  if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };

  // "runs from {start} until/to {end}" — comma optional
  m = text.match(new RegExp(`runs?\\s+from\\s+(?:and\\s+including\\s+)?${d},?\\s+(?:until|to)\\s+(?:and\\s+including\\s+)?${d}`, 'i'));
  if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };

  // "ran between {start} and {end}"
  m = text.match(new RegExp(`ran\\s+between\\s+${d}\\s+and\\s+${d}`, 'i'));
  if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };

  // "period from {start} to {end}" / "period from {start} until {end}"
  m = text.match(new RegExp(`period\\s+from\\s+${d}\\s+(?:to|until)\\s+${d}`, 'i'));
  if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };

  // "from {start} to {end}" with explicit year on both
  m = text.match(new RegExp(`\\bfrom\\s+(?:and\\s+including\\s+)?${d}\\s+(?:to|until|through)\\s+(?:and\\s+including\\s+)?${d}`, 'i'));
  if (m && parseDate(m[1]) && parseDate(m[2])) return { start: parseDate(m[1]), end: parseDate(m[2]) };

  // "commencing {start}" + optional "expir(ing|es)/ends {end}"
  m = text.match(new RegExp(`commenc(?:ing|es)\\s+(?:on\\s+)?${d}`, 'i'));
  const startOnly = m ? parseDate(m[1]) : null;
  m = text.match(new RegExp(`(?:expir(?:ing|es)|ends?|terminates?)\\s+(?:on\\s+)?${d}`, 'i'));
  const endOnly = m ? parseDate(m[1]) : null;
  if (startOnly || endOnly) return { start: startOnly, end: endOnly };

  // "starting {start}" + "ending {end}"
  m = text.match(new RegExp(`starting\\s+(?:on\\s+)?${d}`, 'i'));
  const startOnly2 = m ? parseDate(m[1]) : null;
  m = text.match(new RegExp(`ending\\s+(?:on\\s+)?${d}`, 'i'));
  const endOnly2 = m ? parseDate(m[1]) : null;
  if (startOnly2 || endOnly2) return { start: startOnly2, end: endOnly2 };

  return { start: null, end: null };
}

function parseProgramMax(text) {
  if (!text) return null;
  const CCY = '(SEK|EUR|DKK|NOK|ISK|GBP|USD)';
  const prefixRe = /(?:total\s+maximum\s+amount\s+of\s+|for\s+a\s+(?:total\s+)?(?:maximum\s+)?amount\s+of\s+(?:up\s+to\s+)?|up\s+to\s+(?:a\s+total\s+(?:maximum\s+)?amount\s+of\s+)?|aggregate\s+consideration\s+of\s+up\s+to\s+|programme\s+of\s+up\s+to\s+|of\s+up\s+to\s+)/i;
  // "CCY X,XXX,XXX [million]" — groups: 1=CCY, 2=number, 3=mult
  const m1 = text.match(new RegExp(prefixRe.source + CCY + '\\s*([\\d,. ]+)\\s*(million|billion|mn|bn)?', 'i'));
  // "X,XXX,XXX [million] CCY" — groups: 1=number, 2=mult, 3=CCY
  const m2 = text.match(new RegExp(prefixRe.source + '([\\d,. ]+)\\s*(million|billion|mn|bn)?\\s*' + CCY, 'i'));
  const m = m1 || m2;
  if (!m) return null;
  const numStr  = m1 ? m[2] : m[1];
  const mult_s  = m1 ? (m[3] || '') : (m[2] || '');
  const mult = /billion|bn/i.test(mult_s) ? 1e9 : /million|mn/i.test(mult_s) ? 1e6 : 1;
  const n = parseFloat(String(numStr).replace(/[\s,]/g, '').replace(/\.$/, ''));
  if (!isNaN(n) && n * mult > 10000) return Math.round(n * mult);
  return null;
}

// ── HTTP fetch helpers ────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&rsquo;/g, "'")
    .replace(/&[a-z]{2,6};/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function httpGet(hostname, path, headers = {}) {
  return new Promise(resolve => {
    const req = https.get({
      hostname, path,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json,*/*', ...headers },
    }, res => {
      if ([301, 302].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const loc = res.headers.location;
        const u = loc.startsWith('http') ? new URL(loc) : new URL(`https://${hostname}${loc}`);
        return resolve(httpGet(u.hostname, u.pathname + u.search, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchNordicText(sourceUrl) {
  const u = new URL(sourceUrl);
  const res = await httpGet(u.hostname, u.pathname + u.search);
  if (!res || res.status !== 200) return null;
  return stripHtml(res.body);
}

async function fetchNorwayText(sourceUrl) {
  // source_url = https://newsweb.oslobors.no/message/{msgId}
  const msgId = sourceUrl.split('/').pop();
  if (!msgId) return null;
  const res = await httpGet('api3.oslo.oslobors.no', `/v1/newsreader/message?messageId=${msgId}`, { Accept: 'application/json' });
  if (!res || res.status !== 200) return null;
  try {
    const d = JSON.parse(res.body);
    return d?.data?.message?.body || null;
  } catch { return null; }
}

async function fetchText(sourceUrl, countryCode) {
  if (!sourceUrl) return null;
  try {
    if (countryCode === 'NO') return await fetchNorwayText(sourceUrl);
    if (NORDICS.has(countryCode)) return await fetchNordicText(sourceUrl);
  } catch {}
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function enrichBuybacks() {
  console.log('🔍  Enrich Buyback Programs — fixing dates, program max, completion %');
  const t0 = Date.now();

  const countries = ONLY_COUNTRY
    ? [ONLY_COUNTRY]
    : ['SE', 'DK', 'FI', 'IS', 'NO'];
  console.log(`  Markets: ${countries.join(', ')}`);

  // Fetch all rows for target countries
  const { data: rows, error } = await sb
    .from('buyback_programs')
    .select('id,filing_id,company,country_code,announced_date,execution_date,total_value,cumulative_value,completion_pct,source_url')
    .in('country_code', countries)
    .order('execution_date', { ascending: false });

  if (error) { console.error('  ❌ DB fetch:', error.message); process.exit(1); }
  console.log(`  Loaded ${rows.length} rows`);

  // Group by (company, country_code) → pick most recent execution's source_url
  const groups = {};
  for (const r of rows) {
    const key = `${r.country_code}|${(r.company || '').toLowerCase().slice(0, 40)}`;
    if (!groups[key]) {
      groups[key] = { key, company: r.company, country_code: r.country_code, rows: [], representativeUrl: null };
    }
    groups[key].rows.push(r);
    // First row encountered = most recent (sorted desc by exec date)
    if (!groups[key].representativeUrl && r.source_url) {
      groups[key].representativeUrl = r.source_url;
    }
  }

  const programList = Object.values(groups);
  console.log(`  ${programList.length} unique programs to enrich`);

  let updatedDates = 0, updatedEnd = 0, updatedMax = 0, updatedPct = 0, errors = 0;

  for (let i = 0; i < programList.length; i++) {
    const prog = programList[i];
    if (!prog.representativeUrl) { errors++; continue; }

    const text = await fetchText(prog.representativeUrl, prog.country_code);
    await delay(DELAY_MS);

    if (!text) { errors++; continue; }

    const { start, end } = parseProgramDates(text);
    let programMax = parseProgramMax(text);

    // Derive completion_pct for all rows in this group that have cumulative data
    // and build update objects
    const updates = [];
    for (const r of prog.rows) {
      const upd = {};

      // Fix announced_date if we found a real program start
      if (start && r.announced_date !== start) {
        upd.announced_date = start;
      }

      // Store program_end only when it looks like a genuine program period
      // (> 14 days from start, and end > start). Short spans = execution period false matches.
      if (end && start && end > start) {
        const spanDays = (new Date(end) - new Date(start)) / 86400000;
        if (spanDays >= 14) upd.program_end = end;
      } else if (end && !start) {
        upd.program_end = end; // no start to cross-check, keep it
      }

      // Fill missing total_value (program max)
      if (programMax && !r.total_value) {
        upd.total_value = programMax;
      }

      // Derive completion_pct
      const effectiveMax = r.total_value || programMax;
      const cumul = r.cumulative_value;
      if (effectiveMax && cumul && r.completion_pct == null) {
        const pct = Math.round((cumul / effectiveMax) * 1000) / 10;
        if (pct <= 150) { upd.completion_pct = pct; upd.pct_complete = Math.round(pct); }
      }

      if (Object.keys(upd).length > 0) updates.push({ filing_id: r.filing_id, ...upd });
    }

    if (!updates.length) continue;

    // Apply updates in batch
    for (const upd of updates) {
      const { filing_id, ...fields } = upd;
      // Try update; if program_end column doesn't exist, retry without it
      const safeFields = { ...fields };
      const { error: updErr } = await sb
        .from('buyback_programs')
        .update(safeFields)
        .eq('filing_id', filing_id);

      if (updErr) {
        if (updErr.message?.includes('program_end')) {
          // Column doesn't exist yet — retry without program_end
          delete safeFields.program_end;
          if (Object.keys(safeFields).length > 0) {
            await sb.from('buyback_programs').update(safeFields).eq('filing_id', filing_id);
          }
        } else {
          errors++;
        }
      }
    }

    // Tally what was updated
    const anyWithStart  = updates.some(u => u.announced_date);
    const anyWithEnd    = updates.some(u => u.program_end);
    const anyWithMax    = updates.some(u => u.total_value);
    const anyWithPct    = updates.some(u => u.completion_pct != null);
    if (anyWithStart) updatedDates++;
    if (anyWithEnd)   updatedEnd++;
    if (anyWithMax)   updatedMax++;
    if (anyWithPct)   updatedPct++;

    if ((i + 1) % 20 === 0) {
      console.log(`  … ${i + 1}/${programList.length} — dates:${updatedDates} max:${updatedMax} pct:${updatedPct}`);
    }
  }

  console.log(`\n  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`  Programs with real program_start extracted: ${updatedDates}`);
  console.log(`  Programs with program_end extracted:        ${updatedEnd}`);
  console.log(`  Programs with total_value (max) filled:     ${updatedMax}`);
  console.log(`  Programs with completion_pct derived:       ${updatedPct}`);
  console.log(`  Errors / skipped:                           ${errors}`);
  if (!updatedDates && !updatedMax && !updatedPct) {
    console.log('\n  ⚠  No updates applied — run migrations/005_buyback_program_end.sql in Supabase dashboard first if program_end was the only new field');
  }
}

enrichBuybacks().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
