#!/usr/bin/env node
/**
 * Insider Tracker — Daily Orchestrator
 *
 * Runs all 23 country scrapers sequentially as child processes.
 * Each scraper gets its own process: isolated memory, clean on exit.
 *
 * Usage:
 *   node run-all.js              # Run all markets
 *   node run-all.js DE NL FR     # Run specific countries only
 *   node run-all.js --no-cleanup # Skip the cleanup step
 */

'use strict';

require('dotenv').config();

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

// Log each market run to scraper_runs table so health-check can detect
// genuinely missed runs vs markets that ran but found no new filings.
const { createClient } = require('@supabase/supabase-js');
const _sb = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
})();

async function logRun(countryCode, rowsSaved, durationS, status) {
  if (!_sb || !countryCode) return;
  try {
    await _sb.from('scraper_runs').insert({
      country_code: countryCode,
      rows_saved:   rowsSaved ?? 0,
      duration_s:   durationS,
      status,
    });
  } catch { /* non-fatal */ }
}

// ─── Market registry ──────────────────────────────────────────────────────────
//
// mode: 'http'      → node-fetch / native https  (fast, low memory)
//       'puppeteer' → headless Chromium          (slow, ~400 MB while running)
//
// Puppeteer markets: scrapers not yet built default to http until converted.

const MARKETS = [
  // ── Europe (HTTP) ────────────────────────────────────────────────────────
  { code: 'DE', name: 'Germany',        file: 'germany',     mode: 'http' },
  { code: 'FR', name: 'France',         file: 'france',      mode: 'http' },
  { code: 'GB', name: 'UK',             file: 'uk',          mode: 'http' },
  { code: 'ES', name: 'Spain',          file: 'spain',       mode: 'http' },
  { code: 'IT', name: 'Italy',          file: 'italy',       mode: 'http' },
  { code: 'BE', name: 'Belgium',        file: 'belgium',     mode: 'http' },
  { code: 'SE', name: 'Sweden',         file: 'sweden',      mode: 'http' },
  { code: 'DK', name: 'Denmark',        file: 'denmark',     mode: 'http' },
  { code: 'NO', name: 'Norway',         file: 'norway',      mode: 'http' },
  { code: 'FI', name: 'Finland',        file: 'finland',     mode: 'http' },
  { code: 'CH', name: 'Switzerland',    file: 'switzerland', mode: 'http' },
  { code: 'PT', name: 'Portugal',       file: 'portugal',    mode: 'http' },
  { code: 'LU', name: 'Luxembourg',     file: 'luxembourg',  mode: 'http' },
  // AT, IE, PL, CZ removed — not on platform

  // ── Europe (Puppeteer) ───────────────────────────────────────────────────
  { code: 'NL', name: 'Netherlands',    file: 'netherlands', mode: 'http' },

  // ── Asia-Pacific ─────────────────────────────────────────────────────────
  // AU disabled: ASX Appendix 3Y metadata has no price/shares/name data (all null)
  { code: 'KR', name: 'South Korea',    file: 'southkorea',  mode: 'http' },
  // HK, JP, SG, CA, ZA removed — not on platform
];

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const noCleanup    = args.includes('--no-cleanup');
const filterArgs   = args.filter(a => !a.startsWith('--'));
const filterCodes  = filterArgs.map(a => a.toUpperCase());

const markets = filterCodes.length > 0
  ? MARKETS.filter(m => filterCodes.includes(m.code))
  : MARKETS;

if (filterCodes.length > 0 && markets.length === 0) {
  console.error(`Unknown country code(s): ${filterCodes.join(', ')}`);
  console.error(`Valid codes: ${MARKETS.map(m => m.code).join(', ')}`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = __dirname;
const PAD  = 14;   // label width for alignment

function pad(str, len) {
  return str.padEnd(len);
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

const MARKET_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes — kills hanging scrapers

function runScript(scriptPath, label) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = [];
    let settled = false;

    function finish(ok, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      resolve({ label, ok, elapsed, code, lines });
    }

    // Kill the child after MARKET_TIMEOUT_MS so a single hanging scraper
    // (e.g. Portugal Puppeteer, slow PDF downloads) never blocks the rest.
    const timer = setTimeout(() => {
      console.error(`  ⏱  ${label} TIMEOUT after ${MARKET_TIMEOUT_MS / 60000}min — killing`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000); // force-kill if SIGTERM ignored
      finish(false, -2);
    }, MARKET_TIMEOUT_MS);

    const collect = (stream) => {
      stream.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const out = `  ${trimmed}`;
          console.log(out);
          lines.push(out);
        });
      });
    };

    collect(child.stdout);
    collect(child.stderr);

    child.on('close', code => finish(code === 0, code));

    child.on('error', err => {
      console.error(`  ❌ spawn error: ${err.message}`);
      finish(false, -1);
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runStart = Date.now();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Insider Tracker — Daily Scrape');
  console.log(`  Started:  ${timestamp()}`);
  console.log(`  Markets:  ${markets.length} / ${MARKETS.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const results = [];

  for (const market of markets) {
    const scriptPath = path.join(ROOT, 'scrapers', `${market.file}.js`);

    if (!fs.existsSync(scriptPath)) {
      console.log(`\n[${market.code}] ${market.name} — SKIPPED (scraper not yet built)`);
      results.push({ label: market.code, ok: null, elapsed: '-', code: null });
      continue;
    }

    console.log(`\n[${market.code}] ${market.name}`);
    const result = await runScript(scriptPath, market.code);
    results.push(result);

    // Log to scraper_runs so health-check can tell the difference between
    // "scraper ran but found nothing new" vs "scraper never ran".
    // Parse rows_saved from the scraper's stdout: look for "N saved" or "N rows saved".
    const savedMatch = result.lines
      .slice()
      .reverse()
      .map(l => l.match(/(\d+)\s+(?:rows?\s+)?saved/i))
      .find(Boolean);
    const rowsSaved = savedMatch ? parseInt(savedMatch[1], 10) : 0;

    await logRun(
      market.code,
      rowsSaved,
      parseFloat(result.elapsed) || 0,
      result.ok ? 'success' : (result.code === -2 ? 'timeout' : 'failed'),
    );
  }

  // Buyback scrapers run on a separate weekly schedule (scripts/run-buybacks.sh)
  // and are NOT included in the daily run to avoid unnecessary load.

  // ── Cleanup ──────────────────────────────────────────────────────────────
  if (!noCleanup && filterCodes.length === 0) {
    const cleanupPath = path.join(ROOT, 'scrapers', 'cleanup.js');
    if (fs.existsSync(cleanupPath)) {
      console.log('\n[--] Cleanup (90-day retention)');
      const result = await runScript(cleanupPath, 'cleanup');
      results.push(result);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalElapsed = ((Date.now() - runStart) / 1000).toFixed(0);
  const ok      = results.filter(r => r.ok === true).length;
  const failed  = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.ok === null).length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Run Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (const r of results) {
    if (r.ok === null) {
      console.log(`  ⬜ ${pad(r.label, PAD)} skipped (not built)`);
    } else if (r.ok) {
      console.log(`  ✅ ${pad(r.label, PAD)} ${r.elapsed}s`);
    } else {
      console.log(`  ❌ ${pad(r.label, PAD)} ${r.elapsed}s  (exit ${r.code})`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Finished: ${timestamp()}`);
  console.log(`  Total:    ${totalElapsed}s`);
  console.log(`  Results:  ${ok} ok, ${failed} failed, ${skipped} skipped`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Exit non-zero if any scraper failed (useful for monitoring alerts)
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('❌ Orchestrator fatal:', err.message);
  process.exit(1);
});
