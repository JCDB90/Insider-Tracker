/**
 * Shared Supabase client for all scrapers.
 * Reads credentials from environment variables (set via GitHub Secrets in CI,
 * or a local .env file during development).
 *
 * Required env vars:
 *   SUPABASE_URL              - e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY - service_role key (preferred; bypasses RLS,
 *                                needed now that insider_transactions has
 *                                anon/authenticated INSERT/UPDATE/DELETE
 *                                blocked by RLS policy)
 *   SUPABASE_KEY               - fallback, kept for existing CI secrets that
 *                                may already hold the service_role key under
 *                                this older name. Do NOT put the anon key
 *                                here for scrapers — it can no longer write.
 */

require('dotenv').config();
const { createClient }   = require('@supabase/supabase-js');
const { looksLikeCorp, looksLikeAddress } = require('./entityUtils');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Defense-in-depth: strip markup/script content from free-text fields before
// they reach the DB. The frontend already escapes output correctly (React),
// so this isn't closing an XSS hole that exists today — it's a second layer
// in case a future consumer (email digest HTML, exported CSV opened in a
// tool that renders markup, etc.) doesn't escape as carefully.
function sanitizeString(str) {
  if (typeof str !== 'string' || !str) return str;
  return str
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

const SANITIZE_FIELDS = ['company', 'insider_name', 'via_entity', 'insider_role'];
function sanitizeRow(row) {
  for (const field of SANITIZE_FIELDS) {
    if (row[field]) row[field] = sanitizeString(row[field]);
  }
  return row;
}

// Lazy check: does the via_entity column exist in the DB yet?
let _viaEntityChecked = false;
let _viaEntityExists  = false;
async function hasViaEntityColumn() {
  if (_viaEntityChecked) return _viaEntityExists;
  _viaEntityChecked = true;
  const { error } = await supabase.from('insider_transactions').select('via_entity').limit(1);
  _viaEntityExists = !error;
  if (!_viaEntityExists) {
    console.log('  ℹ  via_entity column not yet in DB — run: node scrapers/migrate-via-entity.js');
  }
  return _viaEntityExists;
}

/**
 * Upsert insider transactions. Deduplicates on filing_id.
 * @param {Array} rows - array of insider_transactions rows
 * @returns {{ inserted: number, error: any }}
 */
async function saveInsiderTransactions(rows, options = {}) {
  const { allowPartial = false } = options;
  if (!rows || rows.length === 0) return { inserted: 0 };

  // Track drop reasons for diagnostics
  const drops = { wrong_type: 0, corp_entity: 0, garbage_name: 0, missing_name: 0, missing_shares: 0, price_zero: 0, transfer_pair: 0 };

  // Only save rows with a clear direction — drop OTHER, UNKNOWN, etc.
  const filtered = rows.filter(r => {
    if (r.transaction_type !== 'BUY' && r.transaction_type !== 'SELL') { drops.wrong_type++; return false; }
    return true;
  });
  if (drops.wrong_type > 0) {
    console.log(`  ℹ  Dropped ${drops.wrong_type} non-BUY/SELL rows (OTHER/UNKNOWN)`);
  }

  // Drop same-day bilateral transfer pairs: same insider, company, date, shares, price
  // with both a BUY and SELL row. These are intra-portfolio transfers (net exposure = 0).
  const xferKey = r => [r.country_code, r.company, r.insider_name, r.transaction_date, r.shares, r.price_per_share].join('|');
  const xferGroups = {};
  for (const r of filtered) {
    const k = xferKey(r);
    if (!xferGroups[k]) xferGroups[k] = [];
    xferGroups[k].push(r);
  }
  const transferPairKeys = new Set(
    Object.entries(xferGroups)
      .filter(([, g]) => g.some(r => r.transaction_type === 'BUY') && g.some(r => r.transaction_type === 'SELL'))
      .map(([k]) => k)
  );
  const deTransfered = filtered.filter(r => {
    if (transferPairKeys.has(xferKey(r))) { drops.transfer_pair++; return false; }
    return true;
  });
  if (drops.transfer_pair > 0) {
    console.log(`  ℹ  Dropped ${drops.transfer_pair} bilateral transfer-pair rows (same-day same-block BUY+SELL)`);
  }
  if (deTransfered.length === 0) return { inserted: 0, drops };

  // Skip corporate entity rows where no individual is identified (via_entity not set).
  // Only real-person transactions belong in insider_transactions.
  const withEntityResolved = deTransfered.filter(r => {
    // A street address is never a person's name — and not useful as via_entity either
    // (via_entity should hold an entity NAME, not its registered address). Cross-scraper
    // safety net: individual scrapers should resolve the real name/entity themselves
    // (see scrapers/luxembourg.js's findPrecedingEntityName), but this catches any
    // future/other scraper that lets an address slip through, e.g. "23, Val Fleuri,
    // L-1526 Luxembourg". If the row also has no via_entity, it's dropped below by the
    // "hasName" check; otherwise the row is kept with its already-resolved via_entity.
    if (r.insider_name && looksLikeAddress(r.insider_name)) {
      console.log(`  ℹ  Nulling address-as-name: "${r.insider_name}" — ${r.company || '?'}`);
      r.insider_name = null;
    }
    if (r.insider_name && !r.via_entity && looksLikeCorp(r.insider_name)) {
      drops.corp_entity++;
      console.log(`  ℹ  Skipping corporate entity: ${r.insider_name} — ${r.company || '?'}`);
      return false;
    }
    return true;
  });

  // Require insider_name, shares > 0, and a positive price_per_share.
  // price=null or price=0 means no real market transaction (vesting, award, or missing data) → skip.
  // Also reject parse artifacts: "them.", single words ending in period under 6 chars.
  const GARBAGE_NAME_RE = /^them\.?$|^they\.?$|^he\.?$|^she\.?$|^it\.?$|^[a-z]{1,5}\.$|^-+$|^\?+$|^an?\s+(?:executive|officer|director|manager|member|person)\b|^the\s+(?:executive|officer|director|manager)\b|^testo\s+del\b|^comunicato\b|\binstruction\s+transmitted\b|\bpurchase\s+instruction\b|^with\s+(?:purchase|order|instruction)|^following\s+(?:the|a|an)\s|^\s*(?:EVP|SVP|VP|CEO|CFO|COO|CTO|CCO|CDO|CRO|CMO|CLO|CPO|MD|ED|GM|IR)\s*$|^(?:Employee.elected|Board\s+member|Non.executive\s+director|Independent\s+director|Employee\s+representative)\b|^Head\s+of\b|\bPart\s+of\s+(?:Management|Executive|Senior|Leadership)\s+(?:Group|Team)\b|^(?:Acting|Interim|Deputy|Former|Outgoing|Incoming)\s+(?:CEO|CFO|COO|CTO|CCO|CIO|CRO|CMO|Chief\s+\w+\s+Officer|Chairman|Chair|Director|President|Officer|Manager|Member|Employee(?:.elected)?\s+representative|Board\s+member)\b/i;
  // Strip U+FFFD replacement characters from names (encoding corruption artifact).
  // These appear when the source API serves Latin-1 text decoded as UTF-8.
  for (const r of withEntityResolved) {
    if (r.insider_name && r.insider_name.includes('�')) {
      console.warn(`  ⚠️  Encoding corruption in name: "${r.insider_name}" — ${r.company || '?'} (${r.filing_id})`);
      r.insider_name = r.insider_name.replace(/�/g, '').trim() || null;
    }
  }

  // Derive missing price or total_value from whichever of the three fields is known.
  // This prevents gaps when a scraper parses one but not both financial fields.
  for (const r of withEntityResolved) {
    const hasP = r.price_per_share > 0;
    const hasV = r.total_value > 0;
    const hasS = r.shares > 0;
    if (!hasP && hasV && hasS) {
      r.price_per_share = parseFloat((r.total_value / r.shares).toFixed(6));
    } else if (!hasV && hasP && hasS) {
      r.total_value = Math.round(r.price_per_share * r.shares);
    }

    // Sanity check: price × shares should roughly equal total_value.
    // If off by >10×, the scraper likely captured a wrong field.
    if (hasP && hasV && hasS) {
      const calc  = r.price_per_share * r.shares;
      const ratio = calc / r.total_value;
      if (ratio > 10) {
        // price × shares >> total_value → total likely wrong
        // Sub-case: total ≤ price (scraper captured unit price as total_value)
        if (r.total_value <= r.price_per_share * 1.1) {
          const corrected = Math.round(calc);
          console.warn(`  ⚠️  Total sanity (total≈price) for ${r.company || '?'} (${r.country_code}): ` +
            `total ${r.total_value} → ${corrected}`);
          r.total_value = corrected;
        } else {
          // total > price but still way off → try implied price from total / shares
          const impliedPrice = r.total_value / r.shares;
          if (impliedPrice > 0 && impliedPrice < r.price_per_share * 0.5) {
            console.warn(`  ⚠️  Price sanity (>10×) for ${r.company || '?'} (${r.country_code}): ` +
              `implied price ${impliedPrice.toFixed(4)} used instead of ${r.price_per_share}`);
            r.price_per_share = parseFloat(impliedPrice.toFixed(6));
            r.total_value     = Math.round(r.price_per_share * r.shares);
          }
        }
      } else if (ratio < 0.1) {
        // price × shares << total_value → total is likely a program/portfolio aggregate
        // Recalculate total_value from price × shares
        const calculatedTotal = Math.round(calc);
        console.warn(`  ⚠️  Total sanity (<0.1×) for ${r.company || '?'} (${r.country_code}): ` +
          `total ${r.total_value} replaced with price×shares = ${calculatedTotal}`);
        r.total_value = calculatedTotal;
      }
    }
  }

  const complete = withEntityResolved.filter(r => {
    if (r.insider_name && GARBAGE_NAME_RE.test(r.insider_name.trim())) {
      drops.garbage_name++;
      console.log(`  ℹ  Rejecting garbage name: "${r.insider_name}" — ${r.company || '?'}`);
      return false;
    }
    // A row has sufficient identity if it has a person name OR a via_entity (corporate disclosure)
    const hasName   = (r.insider_name && r.insider_name.trim() !== '') || !!r.via_entity;
    if (allowPartial) {
      // allowPartial: only require insider identity (shares/price may be null for encrypted-PDF sources like SGX)
      if (!hasName) {
        drops.missing_name++;
        console.log(`  ⚠  Skipping nameless row (${r.company || '?'} ${r.transaction_date || '?'})`);
        return false;
      }
      return true;
    }
    const hasShares = r.shares != null && r.shares > 0;
    const hasPrice  = r.price_per_share != null && r.price_per_share > 0;
    if (!hasName)   { drops.missing_name++;  }
    if (!hasShares) { drops.missing_shares++; }
    if (!hasPrice)  { drops.price_zero++;    }
    if (!hasName || !hasShares || !hasPrice) {
      console.log(`  ⚠  Skipping incomplete row (${r.company || '?'} ${r.transaction_date || '?'}): name=${r.insider_name || 'null'} shares=${r.shares ?? 'null'} price=${r.price_per_share ?? 'null'}`);
      return false;
    }
    return true;
  });
  if (complete.length < withEntityResolved.length) {
    const totalDropped = withEntityResolved.length - complete.length;
    console.log(`  ℹ  Dropped ${totalDropped} rows missing name/shares/price`);
  }
  // Log drop summary when there are notable drops
  const totalDropped = drops.wrong_type + drops.transfer_pair + drops.corp_entity + drops.garbage_name + drops.missing_name + drops.missing_shares + drops.price_zero;
  if (totalDropped > 0 && (drops.missing_shares > 0 || drops.price_zero > 0 || drops.missing_name > 0)) {
    console.log(`  ℹ  Drop summary: wrong_type=${drops.wrong_type} transfer_pair=${drops.transfer_pair} corp=${drops.corp_entity} garbage_name=${drops.garbage_name} missing_name=${drops.missing_name} missing_shares=${drops.missing_shares} price_zero=${drops.price_zero}`);
  }
  if (complete.length === 0) return { inserted: 0 };

  // Warn about rows that pass all filters but genuinely lack an insider identity.
  // Suppress when via_entity is set — that IS a valid identity (corporate disclosure).
  for (const r of complete) {
    if (!r.insider_name && !r.via_entity) {
      console.warn(`  ⚠️  Missing insider name: ${r.company || '?'} (${r.country_code}) — filing ${r.filing_id}`);
    }
  }

  // Strip via_entity from rows if the column doesn't exist yet (avoids DB errors)
  const viaExists = await hasViaEntityColumn();
  const upsertRows = (viaExists
    ? complete
    : complete.map(({ via_entity, ...rest }) => rest)
  ).map(sanitizeRow);

  const { data, error } = await supabase
    .from('insider_transactions')
    .upsert(upsertRows, { onConflict: 'filing_id', ignoreDuplicates: false });

  if (error) {
    // Unique constraint violation: content-hash ID matched an existing row's natural key,
    // OR two rows in the batch share the same natural key (within-batch conflict).
    // NOTE: a whole-batch retry with ignoreDuplicates:true used to sit here as a middle
    // step. It was a real bug — "ON CONFLICT (filing_id) DO NOTHING" means ANY row whose
    // filing_id already exists gets silently skipped, not updated, even when only ONE
    // unrelated row in the batch was the actual natural-key collision. Confirmed live: a
    // batch containing corrected insider_name/transaction_date values for rows that were
    // previously saved with wrong data (an unrelated OCR bug) hit this path and silently
    // kept the stale values — while still reporting a "successful" insert count. Falling
    // straight to per-row upserts (below) avoids this: each row gets a real update-on-
    // conflict attempt, and ignoreDuplicates:true is used only as a last resort for the
    // specific row that still collides after that.
    if (error.code === '23505' || /unique/i.test(error.message)) {
      console.log('  ℹ  Within-batch unique conflict — retrying row-by-row');
      let saved = 0;
      for (const row of upsertRows) {
        let { error: rowErr } = await supabase
          .from('insider_transactions')
          .upsert([row], { onConflict: 'filing_id', ignoreDuplicates: false });
        if (rowErr && rowErr.code === '23505') {
          // This row's new values collide with a DIFFERENT existing row on the natural-key
          // index (not just its own filing_id) — skip it rather than block the batch.
          ({ error: rowErr } = await supabase
            .from('insider_transactions')
            .upsert([row], { onConflict: 'filing_id', ignoreDuplicates: true }));
        }
        if (!rowErr) {
          saved++;
        } else if (rowErr.code !== '23505') {
          console.warn(`  ⚠  Row upsert failed (${row.company}): ${rowErr.code} ${rowErr.message}`);
        }
      }
      return { inserted: saved, drops };
    }
    console.error('  DB error (insider_transactions):', error.message);
    return { inserted: 0, error, drops };
  }
  return { inserted: complete.length, drops };
}

/**
 * Guard against reversed/nonsensical announced_date & program_end values
 * before they reach the DB. Centralized here (not duplicated per-scraper)
 * so every buyback scraper gets the same protection automatically.
 *
 * Root cause this backstops (already fixed at the source in nordic-buybacks.js,
 * norway-buybacks.js, uk-buybacks.js as of 2026-08-06 — this is a safety net
 * for whatever similar date-range parsing bug turns up next, not a substitute
 * for fixing extraction bugs when found): a scraper's date-range regex
 * grabbing the wrong end of a "between X and Y" phrase, or an unrelated date
 * elsewhere in a multi-topic filing, can produce an announced_date that's in
 * the future or that falls after program_end.
 *
 * Swaps announced_date/program_end when the swap is well-justified (the
 * "before" value is a plausible date and the "after" value isn't). When
 * announced_date is in the future and there's no program_end to swap with,
 * nulls announced_date rather than fabricating a value (e.g. "today") that
 * has no basis in the source filing — a program with an unreliable date is
 * better hidden from the frontend's "active programs" view (which requires
 * announced_date to render at all) than shown with a made-up one.
 */
function validateBuybackProgram(row) {
  const today = new Date().toISOString().slice(0, 10);
  if (row.announced_date > today) {
    if (row.program_end && row.program_end <= today) {
      console.warn(`  ⚠  Future announced_date (${row.announced_date}) with past program_end (${row.program_end}) — swapping: ${row.company || '?'}`);
      [row.announced_date, row.program_end] = [row.program_end, row.announced_date];
    } else {
      console.warn(`  ⚠  Future announced_date (${row.announced_date}) with no usable program_end to recover from — nulling: ${row.company || '?'}`);
      row.announced_date = null;
    }
  }
  if (row.announced_date && row.program_end && row.program_end < row.announced_date) {
    console.warn(`  ⚠  program_end (${row.program_end}) before announced_date (${row.announced_date}) — swapping: ${row.company || '?'}`);
    [row.announced_date, row.program_end] = [row.program_end, row.announced_date];
  }
  return row;
}

/**
 * Upsert buyback programs. Deduplicates on filing_id.
 * @param {Array} rows - array of buyback_programs rows
 * @returns {{ inserted: number, error: any }}
 */
async function saveBuybackPrograms(rows) {
  if (!rows || rows.length === 0) return { inserted: 0 };

  const validated = rows.map(validateBuybackProgram).map(sanitizeRow).filter(r => r.announced_date != null);
  if (validated.length < rows.length) {
    console.warn(`  ⚠  Dropped ${rows.length - validated.length} row(s) with unrecoverable announced_date`);
  }
  if (!validated.length) return { inserted: 0 };

  const { data, error } = await supabase
    .from('buyback_programs')
    .upsert(validated, { onConflict: 'filing_id', ignoreDuplicates: false });

  if (error) {
    console.error('  DB error (buyback_programs):', error.message);
    return { inserted: 0, error };
  }
  return { inserted: validated.length };
}

/**
 * Log a scraper run to scraper_runs — same table/shape run-all.js already
 * writes for the daily insider scrapers, extended here so the weekly buyback
 * scrapers (which never wrote to this table before) show up in
 * daily-health-check.js's stale-scraper detection too.
 * @param {string} countryCode
 * @param {number} rowsSaved
 * @param {number} durationS
 * @param {string} status - 'success' | 'failed' | 'timeout'
 */
async function logScraperRun(countryCode, rowsSaved, durationS, status = 'success') {
  if (!countryCode) return;
  try {
    await supabase.from('scraper_runs').insert({
      country_code: countryCode,
      rows_saved:   rowsSaved ?? 0,
      duration_s:   durationS,
      status,
    });
  } catch { /* non-fatal */ }
}

module.exports = { supabase, saveInsiderTransactions, saveBuybackPrograms, logScraperRun };
