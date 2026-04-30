'use strict';
/**
 * DB ticker patch — corrects known wrong tickers in insider_transactions.
 *
 * Covers:
 *  - Old SE rows before the expanded TICKERS map (KINNEV, VIAPLA, INDUTR, EEDUCA, etc.)
 *  - FR PDF extraction errors (COVIVIO, SENSORIO, etc.)
 *  - NL cross-listed companies on wrong exchange (STMPA → strip so ISIN lookup re-resolves)
 *  - DE special cases (MÜHLBA unicode, etc.)
 *
 * Safe to re-run — only updates rows where the current ticker matches the old value.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Each entry: { from, to, country_code (optional — tighten match) }
// 'to' = null means clear the ticker so ISIN re-resolution can fix it later
const CORRECTIONS = [
  // ── Sweden — old 6-char truncation bugs ─────────────────────────────────────
  { from: 'KINNEV',  to: 'KINV-B',   cc: 'SE' },  // Kinnevik
  { from: 'VIAPLA',  to: 'VPLAY-B',  cc: 'SE' },  // Viaplay (already in TICKERS)
  { from: 'INDUTR',  to: 'INDT',     cc: 'SE' },  // Indutrade
  { from: 'EEDUCA',  to: 'ALBER',    cc: 'SE' },  // eEducation Albert
  { from: 'MEDICO',  to: 'MCOV-B',   cc: 'SE' },  // Medicover
  { from: 'NORDNE',  to: 'NORDNET',  cc: 'SE' },  // Nordnet
  { from: 'AVANZA',  to: 'AZA',      cc: 'SE' },  // Avanza Bank
  { from: 'SCANDI',  to: 'SCAND',    cc: 'SE' },  // Scandic Hotels
  { from: 'DIÖS',    to: 'DIOS',     cc: 'SE' },  // Diös Fastigheter (unicode)
  { from: 'CELLAV',  to: 'CEVI',     cc: 'SE' },  // CellaVision
  { from: 'FABEGE',  to: 'FABG',     cc: 'SE' },  // Fabege
  { from: 'BONAVA',  to: 'BONA-B',   cc: 'SE' },  // Bonava
  { from: 'PLATZE',  to: 'PLAZ',     cc: 'SE' },  // Platzer Fastigheter
  { from: 'FLOWSC',  to: 'FLOW-B',   cc: 'SE' },  // Flowscape Technology
  { from: 'DOMETI',  to: 'DOMETIC',  cc: 'SE' },  // Dometic Group
  { from: 'HUMANA',  to: 'HUMA',     cc: 'SE' },  // Humana AB
  { from: 'SWEDEN',  to: 'SWED-B',   cc: 'SE' },  // Swedencare

  // ── France — PDF extraction errors / long names ──────────────────────────────
  { from: 'COVIVIO',  to: 'COV',   cc: 'FR' },
  { from: 'SENSORIO', to: 'SERL',  cc: 'FR' },  // Sensorion
  { from: 'EXOSENS',  to: 'EXOS',  cc: 'FR' },  // Exosens (new IPO 2024)
  { from: 'VOLTALIA', to: 'VOLT',  cc: 'FR' },  // Voltalia — works as VOLT.PA (fallback)

  // ── Germany — special cases ──────────────────────────────────────────────────
  { from: 'MÜHLBA', to: 'MUB',  cc: 'DE' },  // Mühlbauer Holding — unicode ticker

  // ── Norway — ticker too long ─────────────────────────────────────────────────
  { from: 'SMCRT', to: 'SMCR',  cc: 'NO' },  // SmartCraft ASA
];

async function main() {
  console.log('🔧  Ticker map patch — correcting known wrong tickers');
  const t0 = Date.now();

  let total = 0, updated = 0, errors = 0;

  for (const { from, to, cc } of CORRECTIONS) {
    // Count rows to update
    let q = sb.from('insider_transactions').select('id', { count: 'exact', head: true }).eq('ticker', from);
    if (cc) q = q.eq('country_code', cc);
    const { count, error: cErr } = await q;
    if (cErr) { console.error(`  ❌ Count ${from}: ${cErr.message}`); errors++; continue; }
    if (!count) { continue; }

    total += count;
    console.log(`  ${from} → ${to || '(clear)'}  [${cc || 'all'}]  ${count} rows`);

    // Update in batches to avoid timeout
    let done = 0;
    while (done < count) {
      // Fetch IDs for this batch
      let idQ = sb.from('insider_transactions').select('id').eq('ticker', from);
      if (cc) idQ = idQ.eq('country_code', cc);
      const { data: idData, error: idErr } = await idQ.range(0, 199);
      if (idErr || !idData?.length) break;

      const ids = idData.map(r => r.id);
      const { error: upErr } = await sb
        .from('insider_transactions')
        .update({ ticker: to || '' })
        .in('id', ids);

      if (upErr) { console.error(`  ❌ Update ${from}: ${upErr.message}`); errors++; break; }
      updated += ids.length;
      done += ids.length;
      if (done < count) process.stdout.write(`    ${done}/${count}\r`);
    }
    if (done > 0) process.stdout.write(`    ✓ ${done} rows updated\n`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ✅ ${elapsed}s — ${updated}/${total} rows updated  errors:${errors}`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
