#!/usr/bin/env node
/**
 * Writes shared site constants into the static pages, so a price or a signal
 * rule changes in one place only. Runs before every build (package.json "build").
 *
 *   src/pricing.json → <span data-price="pro.annualMonthly">€9.99</span>
 *   src/signals.json → <span data-signal="cluster.windowDays">7</span>
 *
 * Meta tags and JSON-LD can't hold markup, so there:
 *   - "Pro from €X/mo" / "Elite from €X/mo" (JSON-LD) get the price,
 *   - in sentences about cluster buying (not repetitive buying), window
 *     phrasings like "within N days" / "N-day window" get the cluster window.
 *
 * Also warns about unmarked € amounts equal to one of our prices — likely a
 * new hand-typed price. Never fails the build.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..');
const PUBLIC = path.join(FRONTEND, 'public');
const GENERATED_DIRS = new Set(['stocks', 'insiders', 'company']); // their templates read the constants directly
// Pages whose numbers describe a past study, not the live rule: never rewritten.
const FROZEN = new Set(['articles/european-insider-trading-performance-analysis.html']);

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
  const read = f => JSON.parse(fs.readFileSync(path.join(FRONTEND, 'src', f), 'utf8'));
  const PRICES = read('pricing.json');
  const SIGNALS = read('signals.json');
  const eur = n => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const lookup = (obj, key, what) => {
    const [group, field] = key.split('.');
    const v = obj[group] && obj[group][field];
    if (typeof v !== 'number') throw new Error(`unknown ${what} "${key}"`);
    return v;
  };
  // Our prices + previously wrong ones ("from €19/month", Elite "€19.99").
  const SUSPECT = new Set([
    ...Object.values(PRICES).filter(v => typeof v === 'object').flatMap(p => Object.values(p)).map(v => (Number.isInteger(v) ? String(v) : v.toFixed(2))),
    '19', '19.99',
  ]);

  // Cluster-sentence rewrite for text that can't carry spans. Only window
  // phrasings ("within 14 days", "within a 14-day window", "following 14
  // days") — never "180-day history", "at 30, 90 and 180 days" etc.
  const WINDOW_PHRASE = /(\bwithin (?:a |the )?|\bfollowing )\d+(?=(?: calendar)?[ -]days?\b|-day window\b)/gi;
  const clusterDays = text => text.replace(/[^.!?"]*[.!?]?/g, sentence =>
    /cluster/i.test(sentence) && !/repetitive|same insider/i.test(sentence)
      ? sentence.replace(WINDOW_PHRASE, (m, pre) => `${pre}${SIGNALS.cluster.windowDays}`)
      : sentence);

  let changed = 0;
  const warnings = [];
  for (const file of htmlFiles(PUBLIC)) {
    const rel = path.relative(PUBLIC, file).split(path.sep).join('/');
    if (FROZEN.has(rel)) continue;
    const html = fs.readFileSync(file, 'utf8');
    let out = html
      .replace(/(<span data-price="([a-z]+\.[a-zA-Z]+)">)[^<]*(<\/span>)/g, (_, open, key, close) => `${open}${eur(lookup(PRICES, key, 'data-price'))}${close}`)
      .replace(/(<span data-signal="([a-z]+\.[a-zA-Z]+)">)[^<]*(<\/span>)/g, (_, open, key, close) => `${open}${lookup(SIGNALS, key, 'data-signal')}${close}`)
      .replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (_, a, json, b) =>
        a + clusterDays(json.replace(/\b(Pro|Elite) from €[0-9.,]+\/mo/g, (m, plan) => `${plan} from ${eur(PRICES[plan.toLowerCase()].annualMonthly)}/mo`)) + b)
      .replace(/(<meta\b[^>]*\bcontent=")([^"]*)(")/g, (_, a, content, b) => a + clusterDays(content) + b);
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
        warnings.push(`${rel}: …${ctx}…`);
      }
    }
  }
  console.log(`[sync-constants] ${changed} page(s) updated from src/pricing.json + src/signals.json`);
  for (const w of warnings) console.log(`[sync-constants] WARNING unmarked price? ${w}`);
} catch (e) {
  console.log(`[sync-constants] WARNING: ${e.message} — static pages left as they are`);
}
