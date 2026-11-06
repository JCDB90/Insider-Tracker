'use strict';
/**
 * Bot / disposable-email blocklist for Node scripts (lifecycle emails,
 * bot-account cleanup). Single copy for everything server-side in Node.
 *
 * Kept in sync with frontend/src/App.jsx's BLOCKED_DOMAINS / BLOCKED_PATTERNS
 * and migrations/019_block_bot_signups.sql — update all three together.
 */

const BLOCKED_DOMAINS = new Set([
  'mailinator.com', 'maildrop.cc', 'guerrillamail.com', 'guerrillamailblock.com',
  'tempmail.com', 'yopmail.com', 'throwam.com', 'sharklasers.com',
  'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamail.net', 'guerrillamail.org', 'grr.la', 'spam4.me',
  'trashmail.com', 'trashmail.me', 'trashmail.net', 'dispostable.com',
  'example.com', 'example.org', 'example.net',
  'test.com', 'fake.com', 'invalid.com',
  'web-library.net', 'cursor.dev', 'emalupe.com',
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
  const domain = (email || '').split('@')[1]?.trim().toLowerCase();
  return (!!domain && BLOCKED_DOMAINS.has(domain)) ||
         BLOCKED_PATTERNS.some(p => p.test(email || ''));
}

module.exports = { BLOCKED_DOMAINS, BLOCKED_PATTERNS, isBlockedEmail };
