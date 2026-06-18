'use strict';

/**
 * One-time backfill: set company = full company name for all PL insider_transactions
 * where company currently equals the ticker symbol (Bankier scraper stored ticker only).
 *
 * Uses the static PL_COMPANY_NAMES map from tickerMap.js, with a Bankier page
 * fallback for any tickers not yet in the map.
 */

const https  = require('https');
const { createClient } = require('@supabase/supabase-js');
const { PL_COMPANY_NAMES } = require('./lib/tickerMap');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co',
  process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt'
);

function fetchBankierName(ticker) {
  return new Promise(resolve => {
    https.get(`https://www.bankier.pl/inwestowanie/profile/quote.html?symbol=${encodeURIComponent(ticker)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        const m = html.match(/<title>([^<]+)<\/title>/);
        if (m) {
          const nm = m[1].match(/^(.+?)\s*\(/);
          if (nm) return resolve(nm[1].trim());
        }
        resolve(null);
      });
    }).on('error', () => resolve(null)).setTimeout(12000, function() { this.destroy(); resolve(null); });
  });
}

async function main() {
  console.log('── Fix PL company names ────────────────────────────────');

  // Get all distinct (ticker, company) pairs for PL where company = ticker
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('insider_transactions')
      .select('id, ticker, company')
      .eq('country_code', 'PL')
      .range(from, from + 999);
    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  console.log(`  ${all.length} total PL rows`);

  // Only fix rows where company == ticker (still the raw GPW symbol)
  const toFix = all.filter(r => r.ticker && r.company === r.ticker);
  console.log(`  ${toFix.length} rows where company = ticker (need fix)`);

  if (toFix.length === 0) {
    console.log('  ✓ Nothing to fix.');
    return;
  }

  // Group by ticker
  const tickerToRows = new Map();
  for (const r of toFix) {
    if (!tickerToRows.has(r.ticker)) tickerToRows.set(r.ticker, []);
    tickerToRows.get(r.ticker).push(r.id);
  }

  console.log(`  ${tickerToRows.size} unique tickers to resolve`);

  let updated = 0, skipped = 0;

  for (const [ticker, ids] of tickerToRows) {
    // Resolve company name
    let name = PL_COMPANY_NAMES[ticker];
    if (!name) {
      name = await fetchBankierName(ticker);
      await new Promise(r => setTimeout(r, 300));
    }

    if (!name) {
      console.log(`  · ${ticker}: no name found, skipping ${ids.length} rows`);
      skipped += ids.length;
      continue;
    }

    // Update in batches of 50 by ID
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const { error } = await supabase
        .from('insider_transactions')
        .update({ company: name })
        .in('id', batch);
      if (error) {
        console.error(`  ❌ ${ticker}: ${error.message}`);
      } else {
        updated += batch.length;
      }
    }

    console.log(`  ✓ ${ticker} → "${name}" (${ids.length} rows)`);
  }

  console.log(`\n✅ Updated ${updated} rows, skipped ${skipped}`);
  console.log('── done ─────────────────────────────────────────────────');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
