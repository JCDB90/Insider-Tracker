/**
 * Shared Supabase client for all scrapers.
 * Reads credentials from environment variables (set via GitHub Secrets in CI,
 * or a local .env file during development).
 *
 * Required env vars:
 *   SUPABASE_URL  - e.g. https://xxxx.supabase.co
 *   SUPABASE_KEY  - service_role or anon key
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

  const { data, error } = await supabase
    .from('insider_transactions')
    .upsert(filtered, { onConflict: 'filing_id', ignoreDuplicates: true });

  if (error) {
    console.error('  DB error (insider_transactions):', error.message);
    return { inserted: 0, error };
  }
  return { inserted: rows.length };
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
    .upsert(rows, { onConflict: 'filing_id', ignoreDuplicates: true });

  if (error) {
    console.error('  DB error (buyback_programs):', error.message);
    return { inserted: 0, error };
  }
  return { inserted: rows.length };
}

module.exports = { supabase, saveInsiderTransactions, saveBuybackPrograms };
