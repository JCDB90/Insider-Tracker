'use strict';
// Fixes dead /insider/{slug}-insider-trading links (from generate-stock-pages.js,
// which never had a real target page) to point at the real /insiders/{slug}
// pages built by generate-insider-pages.js.
//
// Links to insiders outside the top-500 generated set are left untouched —
// they were already dead before this script and remain so; there's no page
// to point them at.
//
// Usage: node scripts/fix-insider-links.js [--write]

const fs = require('fs');
const path = require('path');

const DRY_RUN = !process.argv.includes('--write');
const STOCKS_DIR   = path.resolve(__dirname, '../frontend/public/stocks');
const INSIDERS_DIR = path.resolve(__dirname, '../frontend/public/insiders');

// Same slug function generate-stock-pages.js used for insider links (bare
// name, no company disambiguation) — needed to compute what old links say.
function oldBareSlug(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function main() {
  console.log(`🔧  Insider link repair (${DRY_RUN ? 'DRY RUN' : 'WRITE MODE'})`);

  const insiderFiles = fs.readdirSync(INSIDERS_DIR).filter(f => f.endsWith('.html'));
  console.log(`  Loaded ${insiderFiles.length} generated insider pages`);

  // Build oldBareSlug -> finalSlug. On collision (same bare slug maps to
  // multiple real people/pages — e.g. same name at two companies) prefer
  // the one with the higher total transaction value as the more likely
  // "primary" target; the other person's stock-page links stay unfixed.
  const bareToFinal = new Map(); // oldBareSlug -> { slug, totalValueEur }
  for (const file of insiderFiles) {
    const html = fs.readFileSync(path.join(INSIDERS_DIR, file), 'utf8');
    const nameMatch = html.match(/<h1>(.*?) Insider Trading<\/h1>/);
    if (!nameMatch) continue;
    const finalSlug = file.replace(/\.html$/, '');
    const bare = oldBareSlug(nameMatch[1]);
    // Rough value proxy: prefer the page whose "Total Bought" isn't "—".
    const hasValue = /Total Bought<\/div>[\s\S]{0,200}/.test(html) && !html.includes('>—</div>\n    <div class="lbl">Total Bought');
    const existing = bareToFinal.get(bare);
    if (!existing || (hasValue && !existing.hasValue)) {
      bareToFinal.set(bare, { slug: finalSlug, hasValue });
    }
  }
  console.log(`  ${bareToFinal.size} distinct old-style bare slugs resolved`);

  const stockFiles = fs.readdirSync(STOCKS_DIR).filter(f => f.endsWith('.html'));
  const LINK_RE = /\/insider\/([a-z0-9-]+)-insider-trading/g;

  let filesChanged = 0, linksFixed = 0, linksLeftDead = 0;
  for (const file of stockFiles) {
    const fp = path.join(STOCKS_DIR, file);
    let html = fs.readFileSync(fp, 'utf8');
    let changed = false;

    html = html.replace(LINK_RE, (match, bareSlug) => {
      const target = bareToFinal.get(bareSlug);
      if (!target) { linksLeftDead++; return match; }
      changed = true;
      linksFixed++;
      return `/insiders/${target.slug}`;
    });

    if (changed) {
      filesChanged++;
      if (!DRY_RUN) fs.writeFileSync(fp, html, 'utf8');
    }
  }

  console.log(`  Files with fixable links: ${filesChanged} / ${stockFiles.length}`);
  console.log(`  Links fixed: ${linksFixed}`);
  console.log(`  Links left dead (insider not in top-500 set): ${linksLeftDead}`);
  if (DRY_RUN) console.log('\n  Dry run — pass --write to apply');
}

main();
