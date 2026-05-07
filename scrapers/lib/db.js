/**
 * Shared Supabase client for all scrapers.
 * Reads credentials from environment variables (set via GitHub Secrets in CI,
 * or a local .env file during development).
 *
 * Required env vars:
 *   SUPABASE_URL  - e.g. https://xxxx.supabase.co
 *   SUPABASE_KEY  - service_role or anon key
 */

const { createClient }   = require('@supabase/supabase-js');
const { looksLikeCorp } = require('./entityUtils');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
async function saveInsiderTransactions(rows) {
  if (!rows || rows.length === 0) return { inserted: 0 };

  // Only save rows with a clear direction — drop OTHER, UNKNOWN, etc.
  const filtered = rows.filter(r => r.transaction_type === 'BUY' || r.transaction_type === 'SELL');
  if (filtered.length < rows.length) {
    console.log(`  ℹ  Dropped ${rows.length - filtered.length} non-BUY/SELL rows (OTHER/UNKNOWN)`);
  }
  if (filtered.length === 0) return { inserted: 0 };

  // Skip corporate entity rows where no individual is identified (via_entity not set).
  // Only real-person transactions belong in insider_transactions.
  const withEntityResolved = filtered.filter(r => {
    if (r.insider_name && !r.via_entity && looksLikeCorp(r.insider_name)) {
      console.log(`  ℹ  Skipping corporate entity: ${r.insider_name} — ${r.company || '?'}`);
      return false;
    }
    return true;
  });

  // Require insider_name, shares > 0, and a positive price_per_share.
  // price=null or price=0 means no real market transaction (vesting, award, or missing data) → skip.
  // Also reject parse artifacts: "them.", single words ending in period under 6 chars.
  const GARBAGE_NAME_RE = /^them\.?$|^they\.?$|^he\.?$|^she\.?$|^it\.?$|^[a-z]{1,5}\.$|^-+$|^\?+$|^an?\s+(?:executive|officer|director|manager|member|person)\b|^the\s+(?:executive|officer|director|manager)\b|^testo\s+del\b|^comunicato\b/i;
  // Strip U+FFFD replacement characters from names (encoding corruption artifact).
  // These appear when the source API serves Latin-1 text decoded as UTF-8.
  for (const r of withEntityResolved) {
    if (r.insider_name && r.insider_name.includes('�')) {
      console.warn(`  ⚠️  Encoding corruption in name: "${r.insider_name}" — ${r.company || '?'} (${r.filing_id})`);
      r.insider_name = r.insider_name.replace(/�/g, '').trim() || null;
    }
  }

  const complete = withEntityResolved.filter(r => {
    if (r.insider_name && GARBAGE_NAME_RE.test(r.insider_name.trim())) {
      console.log(`  ℹ  Rejecting garbage name: "${r.insider_name}" — ${r.company || '?'}`);
      return false;
    }
    const hasName   = r.insider_name && r.insider_name.trim() !== '';
    const hasShares = r.shares != null && r.shares > 0;
    const hasPrice  = r.price_per_share != null && r.price_per_share > 0;
    if (!hasName || !hasShares || !hasPrice) {
      console.log(`  ⚠  Skipping incomplete row (${r.company || '?'} ${r.transaction_date || '?'}): name=${r.insider_name || 'null'} shares=${r.shares ?? 'null'} price=${r.price_per_share ?? 'null'}`);
      return false;
    }
    return true;
  });
  if (complete.length < withEntityResolved.length) {
    console.log(`  ℹ  Dropped ${withEntityResolved.length - complete.length} rows missing name/shares/price`);
  }
  if (complete.length === 0) return { inserted: 0 };

  // Warn about rows that pass all filters but still lack an insider name
  // This helps track filings where the source genuinely doesn't expose names
  for (const r of complete) {
    if (!r.insider_name) {
      console.warn(`  ⚠️  Missing insider name: ${r.company || '?'} (${r.country_code}) — filing ${r.filing_id}`);
    }
  }

  // Strip via_entity from rows if the column doesn't exist yet (avoids DB errors)
  const viaExists = await hasViaEntityColumn();
  const upsertRows = viaExists
    ? complete
    : complete.map(({ via_entity, ...rest }) => rest);

  const { data, error } = await supabase
    .from('insider_transactions')
    .upsert(upsertRows, { onConflict: 'filing_id', ignoreDuplicates: false });

  if (error) {
    console.error('  DB error (insider_transactions):', error.message);
    return { inserted: 0, error };
  }
  return { inserted: complete.length };
}

/**
 * Upsert buyback programs. Deduplicates on filing_id.
 * @param {Array} rows - array of buyback_programs rows
 * @returns {{ inserted: number, error: any }}
 */
async function saveBuybackPrograms(rows) {
  if (!rows || rows.length === 0) return { inserted: 0 };

  const { data, error } = await supabase
    .from('buyback_programs')
    .upsert(rows, { onConflict: 'filing_id', ignoreDuplicates: false });

  if (error) {
    console.error('  DB error (buyback_programs):', error.message);
    return { inserted: 0, error };
  }
  return { inserted: rows.length };
}

module.exports = { supabase, saveInsiderTransactions, saveBuybackPrograms };
