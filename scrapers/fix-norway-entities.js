'use strict';
/**
 * One-time data fix for Norwegian corporate-entity-as-insider-name records.
 *
 * Fixes:
 *  1. "board member in Protector Forsikring" used as insider_name → clear it
 *  2. Drew Holdings Ltd.    → fetch filing, extract real person
 *  3. Heimstø AS            → fetch filing, extract real person
 *  4. Glimt Invest AS       → fetch filing, extract real person (Observe Medical ASA)
 *  5. Granhaug Industrier AS → fetch filing, extract real person (Eqva ASA)
 */

const https = require('https');
const { supabase } = require('./lib/db');

function getJson(urlStr) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://newsweb.oslobors.no',
        'Referer': 'https://newsweb.oslobors.no/',
        'User-Agent': 'Mozilla/5.0',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Try to extract a real person name from a Norwegian filing body.
 * Looks for common patterns like "primary insider NAME", "close associate of NAME",
 * "NAME, [role]", "PDMR: NAME".
 */
function extractPersonFromBody(text) {
  if (!text) return null;
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const WORD = '[A-ZÆØÅ][a-zA-ZÆØÅæøå\\.\\-]{1,25}';

  // "close associate of [Mr./Mrs./Ms.] Name"
  const closeM = clean.match(
    /close\s+associate\s+of\s+(?:Mr\.?\s*|Mrs\.?\s*|Ms\.?\s*)?([A-ZÆØÅ][a-zA-ZÆØÅæøå\- \.]{2,50}(?:\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\-\.]{1,20}){0,3})(?:,|\s+(?:Director|CEO|CFO|Chair|Board|President))/i
  );
  if (closeM) return closeM[1].trim();

  // "primary insider [is] Name" / "PDMR Name" / "primary insider: Name"
  const primaryM = clean.match(
    new RegExp(`(?:primary\\s+insider|PDMR)\\s*[:]?\\s*(?:is\\s+)?(?:Mr\\.?\\s*|Mrs\\.?\\s*)?([A-ZÆØÅ][a-zA-Z\\s\\.\\-]{4,50})(?:,|\\b)`, 'i')
  );
  if (primaryM) {
    const candidate = primaryM[1].trim();
    // Reject if it looks like a role description
    if (!/\b(?:board|member|of|in|at|for)\b/i.test(candidate)) return candidate;
  }

  // "Name, CEO/CFO/Chair/Board/Director of/in Company"
  const personRoleM = clean.match(
    new RegExp(`(${WORD}(?:\\s+${WORD}){1,3}),\\s*(?:CEO|CFO|COO|Chair(?:man)?|Board|Director|President|Managing|Officer|Member)`)
  );
  if (personRoleM) {
    const candidate = personRoleM[1].trim();
    if (/^[A-ZÆØÅ]/.test(candidate)) return candidate;
  }

  return null;
}

async function fetchBodyFromFiling(filingUrl) {
  if (!filingUrl) return null;
  // Extract messageId from URL like https://newsweb.oslobors.no/message/12345
  const m = filingUrl.match(/\/message\/(\d+)/);
  if (!m) return null;
  const msgId = m[1];
  const data = await getJson(`https://api3.oslo.oslobors.no/v1/newsreader/message?messageId=${msgId}`);
  if (!data) return null;
  const msgObj = data.data?.message || data.data || data;
  return msgObj.body || msgObj.content || msgObj.messageBody || null;
}

async function fix() {
  console.log('🔧  Norway entity fix script');

  // ── 1. Clear "board member in Protector Forsikring" as insider_name ──────────
  console.log('\n[1] Fixing Protector Forsikring role-as-name records…');
  const { data: protectorRows, error: pe } = await supabase
    .from('insider_transactions')
    .select('id, insider_name, insider_role, company, filing_url, transaction_date')
    .ilike('insider_name', '%board member%')
    .ilike('company', '%protector%')
    .eq('country_code', 'NO');

  if (pe) { console.error('  ❌ query error:', pe.message); }
  else if (!protectorRows?.length) {
    console.log('  ℹ  No Protector "board member" rows found — already fixed or not present.');
  } else {
    console.log(`  Found ${protectorRows.length} row(s):`);
    for (const row of protectorRows) {
      console.log(`    id=${row.id}  insider_name="${row.insider_name}"  date=${row.transaction_date}`);
      // Try to recover the real person from the filing body
      const body = await fetchBodyFromFiling(row.filing_url);
      const realPerson = extractPersonFromBody(body);
      console.log(`    → real person from body: ${realPerson || '(not found)'}`);

      // Preserve the role description in insider_role, clear insider_name
      const { error: ue } = await supabase
        .from('insider_transactions')
        .update({
          insider_name: realPerson || null,
          insider_role: row.insider_name, // "board member in Protector Forsikring" → role
        })
        .eq('id', row.id);
      if (ue) console.error(`    ❌ update error: ${ue.message}`);
      else    console.log(`    ✅ updated id=${row.id}`);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ── 2–5. Corporate entity insider names ──────────────────────────────────────
  const ENTITY_FIXES = [
    { insider_name: 'Drew Holdings Ltd.', company_hint: null },
    { insider_name: 'Heimstø AS',          company_hint: null },
    { insider_name: 'Glimt Invest AS',     company_hint: 'Observe Medical' },
    { insider_name: 'Granhaug Industrier AS', company_hint: 'Eqva' },
  ];

  for (const fix of ENTITY_FIXES) {
    console.log(`\n[Fix] ${fix.insider_name}…`);
    let query = supabase
      .from('insider_transactions')
      .select('id, insider_name, via_entity, company, filing_url, transaction_date')
      .eq('insider_name', fix.insider_name)
      .eq('country_code', 'NO');
    if (fix.company_hint) query = query.ilike('company', `%${fix.company_hint}%`);

    const { data: rows, error: qe } = await query;
    if (qe) { console.error(`  ❌ query error: ${qe.message}`); continue; }
    if (!rows?.length) { console.log('  ℹ  No rows found — may already be fixed.'); continue; }

    console.log(`  Found ${rows.length} row(s)`);
    for (const row of rows) {
      console.log(`    id=${row.id}  company="${row.company}"  date=${row.transaction_date}`);
      const body = await fetchBodyFromFiling(row.filing_url);
      const realPerson = extractPersonFromBody(body);
      console.log(`    → real person from body: ${realPerson || '(not found)'}`);

      const update = {
        via_entity: fix.insider_name,   // entity goes to via_entity
        insider_name: realPerson || null, // real person (null if not found)
      };
      const { error: ue } = await supabase
        .from('insider_transactions')
        .update(update)
        .eq('id', row.id);
      if (ue) console.error(`    ❌ update error: ${ue.message}`);
      else    console.log(`    ✅ updated — insider_name=${realPerson || 'null'}, via_entity=${fix.insider_name}`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ── 6. INSERT AB Industrivärden into watchlist ────────────────────────────────
  console.log('\n[6] Adding AB Industrivärden to watchlist…');
  const { error: we } = await supabase
    .from('watchlist')
    .upsert([{
      ticker: 'INDU-C',
      company: 'AB Industrivärden',
      country_code: 'SE',
      yahoo_ticker: 'INDU-C.ST',
    }], { onConflict: 'ticker', ignoreDuplicates: true });
  if (we) console.error('  ❌ watchlist insert error:', we.message);
  else    console.log('  ✅ AB Industrivärden added to watchlist');

  console.log('\nDone.');
}

fix().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
