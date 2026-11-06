'use strict';
/**
 * The page files already on disk are the source of truth for URLs.
 *
 * Generated pages used to come and go with each run's selection (top-N lists,
 * name collisions), so indexed URLs silently left the sitemap or changed slug
 * (e.g. /stocks/abb-insider-transactions → abb-se/abb-ch once ABB qualified in
 * two markets). The generators now read the existing files back into
 * "data key → slug" maps so that:
 *   - an existing page keeps its slug,
 *   - an existing page keeps being regenerated while it has data,
 *   - every page file stays listed in the sitemap.
 *
 * Keys (same strings the generators group by):
 *   stocks / company: `${ticker}|${country_code}`
 *   insiders:         `${name}|${company}|${country_code}` (lowercased)
 *
 * New pages carry the key in <meta name="ia-page-key">; older pages are read
 * from their signup link, title and breadcrumb.
 */

const fs = require('fs');
const path = require('path');

function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').trim();
}

function insiderKey(name, company, cc) {
  return `${name}|${company}|${cc}`.toLowerCase();
}

function metaKey(html) {
  const m = /<meta name="ia-page-key" content="([^"]*)"/.exec(html);
  return m ? unescapeHtml(m[1]) : null;
}

function marketCc(html, mktSlugToCc) {
  const m = /href="\/market\/([a-z0-9-]+)-insider-transactions"/.exec(html);
  return m ? mktSlugToCc[m[1]] || null : null;
}

// Reads `dir`/*.html and returns
//   bySlug:  Map(slug → key)
//   byKey:   Map(key → [slugs])
//   aliases: Set(slug) of duplicate pages whose canonical points elsewhere
function readRegistry(dir, extractKey, slugOf = f => f.replace(/\.html$/, '')) {
  const bySlug = new Map();
  const byKey = new Map();
  const aliases = new Set();
  if (!fs.existsSync(dir)) return { bySlug, byKey, aliases };
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const key = metaKey(html) || extractKey(html);
    if (!key) continue;
    const slug = slugOf(file);
    if (/<meta name="ia-alias-of"/.test(html)) aliases.add(slug);
    bySlug.set(slug, key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(slug);
  }
  return { bySlug, byKey, aliases };
}

// /stocks/{slug}-insider-transactions.html and /company/{slug}-insider-transactions.html
function readTickerPages(dir, mktSlugToCc) {
  return readRegistry(dir, html => {
    const signup = /signup\?ticker=([^&"]+)&(?:amp;)?country=([A-Z]{2})/.exec(html);
    if (signup) return `${decodeURIComponent(unescapeHtml(signup[1]))}|${signup[2]}`;
    // Oldest pages: "… at Company (TICKER). 22 transactions tracked …" in the
    // meta description. (A bare "(…)" match would catch "AB (publ)".)
    const cc = marketCc(html, mktSlugToCc);
    const t = /\(([^()"<]+)\)\.\s*\d+ transactions tracked/.exec(html) || /\(([^()<]+)\) Insider Transactions/.exec(html);
    return cc && t ? `${unescapeHtml(t[1])}|${cc}` : null;
  }, f => f.replace(/-insider-transactions\.html$/, ''));
}

// /insiders/{slug}.html — name from <h1>, company + country from the breadcrumb.
function readInsiderPages(dir, mktSlugToCc) {
  return readRegistry(dir, html => {
    const h1 = /<h1>([\s\S]*?) Insider Trading<\/h1>/.exec(html);
    const crumb = /<nav class="breadcrumb"[\s\S]*?<\/nav>/.exec(html);
    if (!h1 || !crumb) return null;
    const links = [...crumb[0].matchAll(/<a href="([^"]*)">([\s\S]*?)<\/a>/g)];
    const company = links.find(l => l[1] !== '/' && !l[1].startsWith('/market/'));
    const cc = marketCc(crumb[0], mktSlugToCc);
    return company && cc ? insiderKey(unescapeHtml(h1[1]), unescapeHtml(company[2]), cc) : null;
  });
}

// Picks the one slug a key's page lives at when several files exist for it.
// Once chosen, the others are written as aliases (canonical → this slug) and
// never become preferred again, so the choice is made once and then sticks.
// First choice: a non-alias slug that was in the sitemap `listed` (pass the
// pre-change sitemap for the one-time migration); else the shortest.
function preferredSlug(slugs, aliases, listed = new Set()) {
  const live = slugs.filter(s => !aliases.has(s));
  const pool0 = live.length ? live : slugs;
  const inSitemap = pool0.filter(s => listed.has(s));
  const pool = inSitemap.length ? inSitemap : pool0;
  return [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

// <head> tags for a duplicate page: canonical to the real page + marker.
function aliasHeadTags(canonicalUrl) {
  return `<meta name="ia-alias-of" content="${canonicalUrl}">`;
}

/**
 * Rewrites one section of the sitemap: fresh entries for the pages generated
 * this run, plus an entry for every other page file still in `dir` — its
 * previous entry if it had one, else one dated from the page's own
 * "Last updated" line. A page only leaves the sitemap when its file is deleted
 * (or it becomes an alias of another page — sitemaps list canonical URLs only).
 */
function writeSitemapSection({ sitemapPath, dir, section, urlFor, slugOf, freshEntries, aliases }) {
  let xml = fs.readFileSync(sitemapPath, 'utf8');
  // Entries are removed with their indentation and line break, so repeated
  // runs don't pile up whitespace-only lines.
  const entryRe = new RegExp(`[ \\t]*<url>\\s*<loc>[^<]*\\/${section}\\/([^<]*)<\\/loc>[\\s\\S]*?<\\/url>[ \\t]*\\n?`, 'g');
  const oldEntries = new Map();
  for (const m of xml.matchAll(entryRe)) oldEntries.set(m[1], m[0]);
  xml = xml.replace(entryRe, '');

  const fresh = new Map(freshEntries.map(e => [e.slug, e.xml]));
  const kept = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort()) {
    const slug = slugOf(file);
    if (fresh.has(slug) || (aliases && aliases.has(slug))) continue;
    const locPath = urlFor(slug).split(`/${section}/`)[1];
    if (oldEntries.has(locPath)) { kept.push(`  ${oldEntries.get(locPath).trim()}`); continue; }
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const updated = /Last updated:\s*(\d{4}-\d{2}-\d{2})/.exec(html);
    kept.push(`  <url>
    <loc>${urlFor(slug)}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>${updated ? `\n    <lastmod>${updated[1]}</lastmod>` : ''}
  </url>`);
  }

  const entries = [...fresh.values(), ...kept].join('\n');
  xml = xml.replace('</urlset>', `${entries}\n</urlset>`).replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(sitemapPath, xml, 'utf8');
  return { fresh: fresh.size, kept: kept.length };
}

/**
 * Pages kept without current data aren't regenerated, so their links were
 * built by older templates — some point at insider/stock/market pages that
 * were never generated (the SPA catch-all then shows the dashboard). Turn
 * every such link into its plain text, and point the old "Log in" button at
 * the sign-in deep link. Returns the number of links changed.
 */
function repairKeptLinks({ dir, publicDir, keep, slugOf }) {
  const targetFile = href => {
    let m;
    if ((m = /^\/insider\/(.+?)(?:-insider-trading)?$/.exec(href))) return path.join(publicDir, 'insiders', `${m[1]}.html`);
    if ((m = /^\/(stocks|insiders|company|market|signals|articles)\/([^/]+)$/.exec(href))) return path.join(publicDir, m[1], `${m[2]}.html`);
    return null; // other links aren't page links this repair understands
  };
  let removed = 0;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
    if (!keep(slugOf(file))) continue;
    const full = path.join(dir, file);
    const html = fs.readFileSync(full, 'utf8');
    let fixed = html.replace(/<a\b[^>]*\bhref="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g, (whole, href, inner) => {
      const target = targetFile(href);
      if (!target || fs.existsSync(target)) return whole;
      removed++;
      return inner;
    });
    // Old alert CTA: "Log in" went to /#watchlist (no sign-in form). Point it
    // at the sign-in deep link for this page's own ticker instead.
    const signup = /href="\/signup\?ticker=([^&"]+)&(?:amp;)?country=([A-Z]{2})"/.exec(fixed);
    const relinked = signup
      ? fixed.replace('<a href="/#watchlist">Log in</a>', `<a href="/signup?ticker=${signup[1]}&amp;country=${signup[2]}&amp;mode=signin">Log in</a>`)
      : fixed;
    if (relinked !== fixed) removed++;
    fixed = relinked;
    if (fixed !== html) fs.writeFileSync(full, fixed, 'utf8');
  }
  return removed;
}

function listedSlugs(sitemapPath, section, slugFromPath) {
  const xml = fs.existsSync(sitemapPath) ? fs.readFileSync(sitemapPath, 'utf8') : '';
  const re = new RegExp(`<loc>[^<]*\\/${section}\\/([^<]*)<\\/loc>`, 'g');
  return new Set([...xml.matchAll(re)].map(m => slugFromPath(m[1])));
}

module.exports = {
  insiderKey, unescapeHtml, readTickerPages, readInsiderPages,
  preferredSlug, aliasHeadTags, writeSitemapSection, listedSlugs, repairKeptLinks,
};
