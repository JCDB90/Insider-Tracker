'use strict';
/**
 * One-off: resolve the ~70 SE company-name collisions found by auditing
 * `SELECT ticker, COUNT(DISTINCT company) ... HAVING COUNT(DISTINCT company) > 1`.
 *
 * Two distinct problems, handled differently:
 *
 *   1. Same company, spelling/casing/typo/"(publ)" variants (most of them) — fixed by
 *      overwriting `company` with CANONICAL_SE_COMPANY[currentTicker]. The ticker is
 *      NEVER recomputed here: re-deriving it from the row's *current* (possibly already
 *      partially-normalized, from an earlier session's fix) company text is unreliable —
 *      TICKERS map keys like 'aktiebolaget trianon' or 'investment aktiebolaget spiltan'
 *      match the raw FI text but not the already-normalized "AB"-form, so re-running
 *      getTicker() on already-fixed rows silently drifted several correct tickers (e.g.
 *      TRIAN-B → FASTIG, SPILTAN → INVEST) the first time this was tried. The ticker these
 *      rows already share is exactly how the collision was found — no need to touch it.
 *
 *   2. Genuinely DIFFERENT companies that auto-derived to the same 6-char ticker (Nordic
 *      LEVEL Group vs NordLEI, Transferator vs Transfer Group, Sobi vs Swedish Logistic
 *      Property, Scandinavian ChemoTech vs Scandinavian Astor, Lundin Mining vs Lundin
 *      Gold, Electrolux vs Electrolux Professional) — these DO need a ticker change, to
 *      the new verified-real ticker added to sweden.js's TICKERS map. Matched explicitly
 *      by company-name substring below, not by re-deriving from current DB state.
 */
const { createClient } = require('@supabase/supabase-js');
const { CANONICAL_SE_COMPANY } = require('./sweden');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Explicit re-ticketing for genuinely different companies that collided on one auto-derived
// ticker. Matched by a company-name substring (stable regardless of prior normalization
// passes), not re-derived via getTicker().
const RETICKET = [
  { match: /nordic level group/i,           newTicker: 'LEVEL' },
  { match: /nordic legal entity identifier/i, newTicker: 'NORDLEI' },
  { match: /transferator/i,                 newTicker: 'TRAN-B' },
  { match: /transfer group/i,               newTicker: 'TRNSF' },
  { match: /swedish orphan biovitrum/i,     newTicker: 'SOBI' },
  { match: /swedish logistic property/i,    newTicker: 'SLP-B' },
  { match: /scandinavian chemotech/i,       newTicker: 'CMOTEC-B' },
  { match: /scandinavian astor/i,           newTicker: 'ASTOR' },
  { match: /lundin mining/i,                newTicker: 'LUMI' },
  { match: /lundin gold/i,                  newTicker: 'LUG' },
  { match: /electrolux professional/i,      newTicker: 'EPRO-B' },
];

async function loadAll() {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('insider_transactions')
      .select('id, ticker, company')
      .eq('country_code', 'SE')
      .not('company', 'is', null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function updateBucket(newFields, ids, label) {
  console.log(`  ${label}  (${ids.length} row(s))`);
  let updated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb.from('insider_transactions').update(newFields).in('id', chunk);
    if (!error) { updated += chunk.length; continue; }
    if (error.code !== '23505' && !/unique/i.test(error.message)) {
      console.error(`    ❌ Update failed: ${error.message}`);
      continue;
    }
    // Exact-duplicate collision after the rename — apply row by row so the rest of the
    // chunk still gets fixed, and report which specific row was left as a duplicate.
    for (const id of chunk) {
      const { error: rowErr } = await sb.from('insider_transactions').update(newFields).eq('id', id);
      if (rowErr) console.warn(`    ⚠  row ${id} left unchanged (would duplicate an existing row): ${rowErr.message}`);
      else updated++;
    }
  }
  return updated;
}

async function main() {
  const rows = await loadAll();
  console.log(`${rows.length} SE rows loaded`);
  let totalUpdated = 0;

  // ── Step 1: re-ticket genuinely different companies onto their new distinct ticker ──
  for (const { match, newTicker } of RETICKET) {
    const targets = rows.filter(r => match.test(r.company) && r.ticker !== newTicker);
    if (!targets.length) continue;
    const company = CANONICAL_SE_COMPANY[newTicker];
    totalUpdated += await updateBucket(
      { ticker: newTicker, company },
      targets.map(r => r.id),
      `${targets[0].ticker} → ${newTicker}: "${company}"`
    );
  }

  // ── Step 2: normalize company display name only, ticker untouched ──────────────────
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  for (const [ticker, group] of byTicker) {
    const canonical = CANONICAL_SE_COMPANY[ticker];
    if (!canonical) continue;
    const targets = group.filter(r => r.company !== canonical && !RETICKET.some(x => x.match.test(r.company)));
    if (!targets.length) continue;
    totalUpdated += await updateBucket(
      { company: canonical },
      targets.map(r => r.id),
      `[${ticker}] -> "${canonical}"`
    );
  }

  console.log(`\nDone. ${totalUpdated} row(s) updated.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
