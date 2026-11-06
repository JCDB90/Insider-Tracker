#!/usr/bin/env node
/**
 * Writes plan prices from src/pricing.json into the static pages, so a price
 * changes in one place only. Runs before every build (package.json "build").
 *
 * In HTML, each of our own prices is marked:
 *   <span data-price="pro.annualMonthly">€9.99</span>
 * and gets its text replaced. JSON-LD can't hold markup, so FAQ answers there
 * use the phrase "Pro from €X/mo" / "Elite from €X/mo", which is rewritten too.
 *
 * Also warns about unmarked € amounts equal to one of our prices — likely a
 * new hand-typed price. Never fails the build.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..');
const PUBLIC = path.join(FRONTEND, 'public');
const GENERATED_DIRS = new Set(['stocks', 'insiders', 'company']); // no prices in generated pages
function htmlFiles(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (!GENERATED_DIRS.has(f)) out.push(...htmlFiles(p)); }
    else if (f.endsWith('.html')) out.push(p);
  }
  return out;
}

try {
  const PRICES = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'src', 'pricing.json'), 'utf8'));
  const eur = n => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;
  // Our prices + previously wrong ones ("from €19/month", Elite "€19.99").
  const SUSPECT = new Set([
    ...Object.values(PRICES).filter(v => typeof v === 'object').flatMap(p => Object.values(p)).map(v => (Number.isInteger(v) ? String(v) : v.toFixed(2))),
    '19', '19.99',
  ]);
  const priceOf = key => {
    const [plan, field] = key.split('.');
    const v = PRICES[plan] && PRICES[plan][field];
    if (typeof v !== 'number') throw new Error(`unknown data-price "${key}"`);
    return eur(v);
  };
  let changed = 0;
  const warnings = [];
  for (const file of htmlFiles(PUBLIC)) {
    const html = fs.readFileSync(file, 'utf8');
    let out = html.replace(/(<span data-price="([a-z]+\.[a-zA-Z]+)">)[^<]*(<\/span>)/g,
      (_, open, key, close) => `${open}${priceOf(key)}${close}`);
    out = out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (_, a, json, b) =>
      a + json.replace(/\b(Pro|Elite) from €[0-9.,]+\/mo/g, (m, plan) => `${plan} from ${eur(PRICES[plan.toLowerCase()].annualMonthly)}/mo`) + b);
    if (out !== html) { fs.writeFileSync(file, out, 'utf8'); changed++; }

    // Drift check: an unmarked € amount equal to one of our prices (or a
    // known stale one) is probably a hand-typed price. Competitor prices that
    // happen to match ours are marked <span data-competitor-price>.
    const visible = out
      .replace(/<span data-(?:price="[^"]*"|competitor-price)>[^<]*<\/span>/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '');
    for (const m of visible.matchAll(/€\s?(\d+(?:[.,]\d{2})?)(?![\d,.])/g)) {
      if (SUSPECT.has(m[1].replace(',', '.'))) {
        const ctx = visible.slice(Math.max(0, m.index - 50), m.index + 20).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        warnings.push(`${path.relative(PUBLIC, file)}: …${ctx}…`);
      }
    }
  }
  console.log(`[sync-prices] ${changed} page(s) updated from src/pricing.json`);
  for (const w of warnings) console.log(`[sync-prices] WARNING unmarked price? ${w}`);
} catch (e) {
  console.log(`[sync-prices] WARNING: ${e.message} — static prices left as they are`);
}
