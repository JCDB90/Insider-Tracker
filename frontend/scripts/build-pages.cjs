#!/usr/bin/env node
/**
 * Regenerates the static SEO pages (stocks, insiders, company, signals +
 * sitemap.xml) from live data right before `vite build`, so every deploy —
 * including the daily one triggered from scrape-daily.yml — ships fresh pages.
 *
 * FAIL-SAFE: this script never fails the build. If the generator scripts are
 * missing, the DB is unreachable, any generator errors or times out, or the
 * sitemap shrinks suspiciously, every generated file is restored to the
 * committed version and the deploy goes ahead with those pages.
 *
 * Reads with the publishable key only. Generators run with a minimal env —
 * nothing from the build environment (e.g. SUPABASE_SERVICE_ROLE_KEY, which
 * Vercel exposes to builds for the /api functions) is passed through.
 *
 * Runs on Vercel (VERCEL=1) or with GENERATE_PAGES=1; a plain local
 * `npm run build` leaves the committed pages alone.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPABASE_URL = 'https://loqmxllfjvdwamwicoow.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';

const FRONTEND = path.resolve(__dirname, '..');
const REPO = path.resolve(FRONTEND, '..');
const PUBLIC = path.join(FRONTEND, 'public');
const GENERATED = ['stocks', 'insiders', 'company', 'signals', 'sitemap.xml']
  .map(p => path.join(PUBLIC, p))
  .concat(path.join(FRONTEND, 'vercel.json'));

// Order matters: pages only link to pages that exist on disk. Insider pages
// run twice — first so stock pages can link to them, then again so they can
// link to stock pages created in this run. Signal pages link to stock pages.
const GENERATORS = [
  ['generate-insider-pages.js', ['--limit', '1000']],
  ['generate-stock-pages.js', ['--limit', '100000']],
  ['generate-insider-pages.js', ['--limit', '1000']],
  ['generate-company-pages.js', []],
  ['generate-signal-pages.js', []],
];
const GENERATOR_TIMEOUT_MS = 8 * 60 * 1000;
// Restore if any generated section of the sitemap lost more than this share
// of its URLs (checked per section so growth in one can't mask another).
const MAX_SITEMAP_SHRINK = 0.10;
const SITEMAP_SECTIONS = ['stocks', 'insiders', 'company', 'signals'];

const log = msg => console.log(`[build-pages] ${msg}`);

function sitemapCounts() {
  let xml = '';
  try { xml = fs.readFileSync(path.join(PUBLIC, 'sitemap.xml'), 'utf8'); } catch { /* counts stay 0 */ }
  const counts = { total: (xml.match(/<url>/g) || []).length };
  for (const s of SITEMAP_SECTIONS) counts[s] = (xml.match(new RegExp(`<loc>[^<]*/${s}/`, 'g')) || []).length;
  return counts;
}

function backup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-pages-'));
  for (const src of GENERATED) {
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, path.relative(FRONTEND, src)), { recursive: true });
  }
  return dir;
}

function restore(dir) {
  for (const dest of GENERATED) {
    const saved = path.join(dir, path.relative(FRONTEND, dest));
    fs.rmSync(dest, { recursive: true, force: true });
    if (fs.existsSync(saved)) fs.cpSync(saved, dest, { recursive: true });
  }
}

async function dbReachable() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/insider_transactions?select=id&limit=1`, {
      headers: { apikey: PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(15000),
    });
    const rows = res.ok ? await res.json() : [];
    return res.ok && rows.length === 1;
  } catch { return false; }
}

function runGenerator(file, args) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.tmpdir(),
    NODE_PATH: path.join(FRONTEND, 'node_modules'),
    SUPABASE_URL,
    SUPABASE_KEY: PUBLISHABLE_KEY,
  };
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', file), ...args], {
    cwd: REPO, env, timeout: GENERATOR_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-5).join('\n    ');
    throw new Error(`${file} failed after ${secs}s (${why})\n    ${tail}`);
  }
  const generated = (r.stdout.match(/Generated:\s*(\d+)/) || [])[1];
  log(`${file} ok in ${secs}s${generated ? ` — ${generated} pages` : ''}`);
}

async function main() {
  if (!process.env.VERCEL && process.env.GENERATE_PAGES !== '1') {
    log('skipped (not a Vercel build; set GENERATE_PAGES=1 to run locally)');
    return;
  }
  const missing = GENERATORS.map(([f]) => f).filter(f => !fs.existsSync(path.join(REPO, 'scripts', f)));
  if (missing.length) {
    log(`WARNING: generator scripts not found (${missing.join(', ')}) — keeping committed pages`);
    return;
  }
  if (!(await dbReachable())) {
    log('WARNING: Supabase unreachable with the publishable key — keeping committed pages');
    return;
  }

  const before = sitemapCounts();
  const saved = backup();
  try {
    for (const [file, args] of GENERATORS) runGenerator(file, args);
    const after = sitemapCounts();
    for (const key of ['total', ...SITEMAP_SECTIONS]) {
      if (after[key] < before[key] * (1 - MAX_SITEMAP_SHRINK)) {
        throw new Error(`sitemap ${key} shrank from ${before[key]} to ${after[key]} URLs`);
      }
    }
    log(`done — sitemap ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  } catch (e) {
    restore(saved);
    log(`WARNING: ${e.message}\n[build-pages] restored committed pages; build continues`);
  } finally {
    fs.rmSync(saved, { recursive: true, force: true });
  }
}

main().catch(e => {
  log(`WARNING: unexpected error, build continues: ${e.stack || e.message}`);
}).finally(() => process.exit(0));
