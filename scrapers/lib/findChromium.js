'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Resolve a working Chromium/Chrome executable path for Puppeteer — shared
 * by portugal.js, singapore.js, and buybacks/spain-buybacks.js.
 *
 * Every candidate is verified with fs.existsSync() before being trusted —
 * an earlier version of this logic (duplicated per-scraper) returned
 * puppeteer.executablePath() unconditionally with no existence check, which
 * silently broke portugal.js for 7+ weeks with an opaque spawn ENOENT.
 *
 * Confirmed live (2026-08-06): even with that existence check in place,
 * portugal.js and singapore.js were BOTH still saving 0 rows on every run
 * under run-daily.sh's cron+.env-sourced context — scraper_runs shows
 * duration ~1.5-2s (too fast for a real Puppeteer session) going back to at
 * least 2026-07-18, while the same scrapers worked fine run directly by a
 * developer in an interactive shell. puppeteer.executablePath()'s internal
 * cache-dir computation apparently resolves differently in that cron
 * context than a plain `os.homedir()` lookup does (most likely something in
 * the sourced .env — e.g. XDG_CACHE_HOME or PUPPETEER_CACHE_DIR set for an
 * unrelated purpose — redirecting it away from where Chrome is actually
 * installed). Root cause not confirmed on the actual host (no verified SSH
 * access to it), so the fix here doesn't depend on it: a direct filesystem
 * scan of the real puppeteer download cache is added as a final fallback,
 * independent of whatever puppeteer.executablePath() itself computes.
 *
 * That fallback deliberately globs for whatever Chrome build version is
 * actually installed (chrome / linux-<version> / chrome-linux64 / chrome)
 * rather than hardcoding one — Puppeteer bumps its bundled Chrome version on every
 * upgrade, so a literal version string (e.g. "linux-146.0.7680.153") would
 * just break again the next time that happens, the exact "unverified
 * hardcoded path" failure mode this project has already been burned by
 * once.
 */
function findChromium() {
  const checked = [];
  function existingPath(p) {
    checked.push(p);
    try { return p && fs.existsSync(p) ? p : null; } catch { return null; }
  }

  const envPath = existingPath(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (envPath) return envPath;

  const systemCandidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of systemCandidates) {
    const hit = existingPath(p);
    if (hit) return hit;
  }

  try {
    const puppeteer = require('puppeteer');
    const bundled = existingPath(puppeteer.executablePath());
    if (bundled) return bundled;
  } catch {}

  try {
    const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    const versions = fs.readdirSync(cacheDir).filter(d => d.startsWith('linux-'));
    versions.sort().reverse(); // newest build first, in case more than one is cached
    for (const v of versions) {
      const hit = existingPath(path.join(cacheDir, v, 'chrome-linux64', 'chrome'));
      if (hit) return hit;
    }
  } catch {}

  console.log(`  ⚠  No Chromium found (checked: ${checked.filter(Boolean).join(', ') || '(no candidates)'})`);
  return null;
}

module.exports = { findChromium };
