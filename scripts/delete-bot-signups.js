'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * Bulk-delete existing bot/disposable-email accounts from Supabase Auth.
 *
 * Uses the SAME blocklist as frontend/src/App.jsx (isBlockedEmail) and
 * migrations/019_block_bot_signups.sql — that migration stops NEW bot
 * signups going forward; this script cleans up accounts that were already
 * created before it's applied (or before this blocklist update).
 *
 * Deleting via supabase.auth.admin.deleteUser() cascades to user_profiles
 * and watchlist (both FK auth.users(id) ON DELETE CASCADE) — no separate
 * cleanup of those tables needed.
 *
 * Usage:
 *   node scripts/delete-bot-signups.js              # dry run — lists matches only
 *   node scripts/delete-bot-signups.js --confirm     # actually deletes
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env (Supabase → Settings → API →
 * service_role key) — the anon key cannot list or delete other users' auth
 * accounts.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFIRM       = process.argv.includes('--confirm');

if (!SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set in .env — required to list/delete auth users.');
  console.error('   Get it from Supabase dashboard → Settings → API → service_role key.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Kept in sync with frontend/src/App.jsx's BLOCKED_DOMAINS / BLOCKED_PATTERNS
// and migrations/019_block_bot_signups.sql — update all three together.
const BLOCKED_DOMAINS = new Set([
  'mailinator.com', 'maildrop.cc', 'guerrillamail.com', 'guerrillamailblock.com',
  'tempmail.com', 'yopmail.com', 'throwam.com', 'sharklasers.com',
  'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamail.net', 'guerrillamail.org', 'grr.la', 'spam4.me',
  'trashmail.com', 'trashmail.me', 'trashmail.net', 'dispostable.com',
  'example.com', 'example.org', 'example.net',
  'test.com', 'fake.com', 'invalid.com',
  'web-library.net', 'cursor.dev',
]);

const BLOCKED_PATTERNS = [
  /security[.\-_]review/i,
  /security\d+/i,
  /test[.\-_]\d+/i,
  /\d{10,}/,
  /^appsec/i,
  /appsec[-.]review/i,
  /appsec\d+/i,
  /^sec[.\-]review/i,
  /^probe\d+/i,
  /^test\d{5,}/i,
  /^redir[-.]probe/i,
  /^secmeta\d+/i,
  /^appscan\d+/i,
];

function isBlockedEmail(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase();
  return (!!domain && BLOCKED_DOMAINS.has(domain)) ||
         BLOCKED_PATTERNS.some(p => p.test(email));
}

async function listAllUsers() {
  const PAGE = 1000;
  const all = [];
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw new Error(`listUsers page ${page}: ${error.message}`);
    all.push(...(data?.users ?? []));
    if (!data?.users?.length || data.users.length < PAGE) break;
    page++;
  }
  return all;
}

async function main() {
  console.log('🔍  Scanning Supabase Auth users for bot/disposable-email matches…');
  const users = await listAllUsers();
  console.log(`  ${users.length} total user(s) in auth.users`);

  const matches = users.filter(u => isBlockedEmail(u.email));
  console.log(`  ${matches.length} match(es) found\n`);

  if (!matches.length) {
    console.log('Nothing to delete.');
    return;
  }

  // Group by matched domain for a readable summary
  const byDomain = {};
  for (const u of matches) {
    const domain = (u.email || '').split('@')[1]?.toLowerCase() || '(pattern match)';
    (byDomain[domain] ??= []).push(u.email);
  }
  for (const [domain, emails] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${domain}: ${emails.length}`);
  }

  if (!CONFIRM) {
    console.log('\n[DRY RUN] Re-run with --confirm to actually delete these accounts.');
    console.log('Sample matches:');
    matches.slice(0, 20).forEach(u => console.log(`  - ${u.email} (${u.id}, created ${u.created_at})`));
    if (matches.length > 20) console.log(`  ... and ${matches.length - 20} more`);
    return;
  }

  console.log(`\nDeleting ${matches.length} account(s)…`);
  let deleted = 0, failed = 0;
  for (const u of matches) {
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (error) {
      failed++;
      console.error(`  ❌ ${u.email}: ${error.message}`);
    } else {
      deleted++;
      console.log(`  ✅ deleted ${u.email}`);
    }
  }
  console.log(`\nDone. ${deleted} deleted, ${failed} failed.`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
