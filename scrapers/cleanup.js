/**
 * Deletes records older than 90 days from both tables.
 * Run once daily, after all scrapers complete.
 * Keeps the Supabase free tier database well under 500 MB.
 */

const { supabase } = require('./lib/db');

const RETENTION_DAYS = 90;

async function cleanup() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffDate = cutoff.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log(`🧹 Cleanup: deleting records older than ${RETENTION_DAYS} days (before ${cutoffDate})`);

  // ── insider_transactions ──────────────────────────────────────────────────
  const { error: txError, count: txCount } = await supabase
    .from('insider_transactions')
    .delete({ count: 'exact' })
    .lt('transaction_date', cutoffDate);

  if (txError) {
    console.error('  ❌ Error cleaning insider_transactions:', txError.message);
  } else {
    console.log(`  ✅ Deleted ${txCount ?? '?'} insider transactions`);
  }

  // ── buyback_programs ──────────────────────────────────────────────────────
  const { error: bbError, count: bbCount } = await supabase
    .from('buyback_programs')
    .delete({ count: 'exact' })
    .lt('announced_date', cutoffDate);

  if (bbError) {
    console.error('  ❌ Error cleaning buyback_programs:', bbError.message);
  } else {
    console.log(`  ✅ Deleted ${bbCount ?? '?'} buyback programs`);
  }

  console.log('🧹 Cleanup complete');
}

cleanup().catch(err => {
  console.error('Cleanup fatal error:', err.message);
  process.exit(1);
});
