/**
 * Post-scrape maintenance.
 *
 * insider_transactions: kept FOREVER — enables long-term insider rating accuracy.
 *   (DB is ~6 MB today, steady-state ~14 MB — well under 500 MB free tier.)
 *
 * buyback_programs: pruned after 2 years (programs are stale after that).
 */

const { supabase } = require('./lib/db');

const BUYBACK_RETENTION_DAYS = 730;  // 2 years

async function cleanup() {
  console.log('🧹 Cleanup: insider_transactions kept forever — skipping deletion');

  // ── buyback_programs ──────────────────────────────────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BUYBACK_RETENTION_DAYS);
  const cutoffDate = cutoff.toISOString().split('T')[0];

  const { error: bbError, count: bbCount } = await supabase
    .from('buyback_programs')
    .delete({ count: 'exact' })
    .lt('announced_date', cutoffDate);

  if (bbError) {
    console.error('  ❌ Error cleaning buyback_programs:', bbError.message);
  } else {
    console.log(`  ✅ Buyback programs older than 2 years: deleted ${bbCount ?? 0}`);
  }

  console.log('🧹 Cleanup complete');
}

cleanup().catch(err => {
  console.error('Cleanup fatal error:', err.message);
  process.exit(1);
});
