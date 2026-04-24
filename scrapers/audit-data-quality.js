'use strict';
/**
 * Data quality audit — runs all 5 checks client-side via Supabase JS.
 */
const { supabase } = require('./lib/db');
const { looksLikeCorp } = require('./lib/entityUtils');

// ─── helpers ──────────────────────────────────────────────────────────────────
async function fetchAll(table, select = '*', order = 'transaction_date') {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table).select(select)
      .order(order, { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) { if (error) console.error('  fetch error:', error.message); break; }
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function tbl(rows, cols) {
  if (!rows.length) return '  (none)';
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = cols.map((c, i) => c.padEnd(w[i])).join(' | ');
  const sep  = w.map(n => '-'.repeat(n)).join('-+-');
  return [line, sep, ...rows.map(r => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join(' | '))].join('\n');
}

// ─── Q1: Corporate entities slipped through ──────────────────────────────────
const CORP_RE = /\b(SA|SRL|SPA|NV|BV|AS|A\/S|ApS|LLC|LTD|GmbH|SARL|SAS|SL|UG|KG|OHG|Holding|Holdings|Capital|Invest|Partners|Fund|Pension|Foundation|Trust|Management|Group|Participations)\b/i;
const CORP_WORDS_RE = /société|sociedad|societa|vennootschap/i;

// ─── Q2: Untranslated roles ───────────────────────────────────────────────────
const UNTRANS_RE = /Président|Directeur|Consiglio|Delegato|Consejero|Bestuurder|Commissaris|Styreleder|Administrerende|Persona|Rilevante|Vinculada|Dirigente|Gérant|Administrateur|Consigliere|Presidente|Presidente\s+del|Direttore|Direttrice|Administrador|Alta\s+Direcci|Vorstandsmitglied|Vorstand|Aufsichtsrat|Verkställande|Ordförande|Styrelseledamot|Hallituksen|Toimitusjohtaja|Bestyrelsesformand|Bestyrelsesmedlem|Administrerende\s+Direktør/i;

// ─── Q5: Garbage names ───────────────────────────────────────────────────────
const GARBAGE_RE = /^(them|they|he|she|it|the|and|or|via|mr|ms|dr|not\s+disclosed|n\/a)\.?$/i;

async function main() {
  console.log('Loading insider_transactions…');
  const rows = await fetchAll('insider_transactions',
    'id,country_code,insider_name,via_entity,insider_role,transaction_type,price_per_share,transaction_date,company,filing_url'
  );
  console.log(`  Loaded ${rows.length} rows\n`);

  // ── Q1: Corporate entities ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Q1: CORPORATE ENTITIES (via_entity IS NULL)');
  console.log('═══════════════════════════════════════════════════════════');
  const q1 = {};
  for (const r of rows) {
    const name = r.insider_name || '';
    if (r.via_entity) continue;
    if ((CORP_RE.test(name) || CORP_WORDS_RE.test(name)) && !looksLikeCorp(name) === false) continue;
    if (!CORP_RE.test(name) && !CORP_WORDS_RE.test(name)) continue;
    const key = `${r.country_code}|||${name}`;
    if (!q1[key]) q1[key] = { country_code: r.country_code, insider_name: name, cnt: 0, ids: [] };
    q1[key].cnt++;
    q1[key].ids.push(r.id);
  }
  const q1rows = Object.values(q1).sort((a,b) => a.country_code.localeCompare(b.country_code) || b.cnt - a.cnt);
  console.log(tbl(q1rows.slice(0, 30), ['country_code', 'insider_name', 'cnt']));
  console.log(`  Total groups: ${q1rows.length}\n`);

  // ── Q2: Untranslated roles ─────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Q2: UNTRANSLATED ROLES');
  console.log('═══════════════════════════════════════════════════════════');
  const q2 = {};
  for (const r of rows) {
    const role = r.insider_role || '';
    if (!UNTRANS_RE.test(role)) continue;
    const key = `${r.country_code}|||${role}`;
    if (!q2[key]) q2[key] = { country_code: r.country_code, insider_role: role, cnt: 0, ids: [] };
    q2[key].cnt++;
    q2[key].ids.push(r.id);
  }
  const q2rows = Object.values(q2).sort((a,b) => a.country_code.localeCompare(b.country_code) || b.cnt - a.cnt);
  console.log(tbl(q2rows.slice(0, 50), ['country_code', 'insider_role', 'cnt']));
  console.log(`  Total groups: ${q2rows.length}\n`);

  // ── Q3: Null/zero prices ───────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Q3: NULL/ZERO PRICES by country');
  console.log('═══════════════════════════════════════════════════════════');
  const q3 = {};
  for (const r of rows) {
    if (r.price_per_share !== null && r.price_per_share !== 0) continue;
    q3[r.country_code] = (q3[r.country_code] || 0) + 1;
  }
  const q3rows = Object.entries(q3).map(([country_code, cnt]) => ({ country_code, cnt })).sort((a,b) => b.cnt - a.cnt);
  console.log(tbl(q3rows, ['country_code', 'cnt']));
  console.log();

  // ── Q4: Bad transaction types ─────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Q4: BAD TRANSACTION TYPES');
  console.log('═══════════════════════════════════════════════════════════');
  const q4 = {};
  for (const r of rows) {
    if (r.transaction_type === 'BUY' || r.transaction_type === 'SELL') continue;
    const key = `${r.country_code}|||${r.transaction_type}`;
    q4[key] = (q4[key] || 0) + 1;
  }
  const q4rows = Object.entries(q4).map(([k, cnt]) => { const [country_code, transaction_type] = k.split('|||'); return { country_code, transaction_type, cnt }; }).sort((a,b) => b.cnt - a.cnt);
  console.log(tbl(q4rows, ['country_code', 'transaction_type', 'cnt']));
  console.log();

  // ── Q5: Garbage names ─────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Q5: GARBAGE NAMES');
  console.log('═══════════════════════════════════════════════════════════');
  const q5 = {};
  for (const r of rows) {
    const name = r.insider_name || '';
    if (!name) continue;
    const isShort = name.trim().length < 4;
    const isGarbage = GARBAGE_RE.test(name.trim());
    if (!isShort && !isGarbage) continue;
    const key = `${r.country_code}|||${name}`;
    if (!q5[key]) q5[key] = { country_code: r.country_code, insider_name: name, cnt: 0, ids: [] };
    q5[key].cnt++;
    q5[key].ids.push(r.id);
  }
  const q5rows = Object.values(q5).sort((a,b) => a.country_code.localeCompare(b.country_code) || b.cnt - a.cnt);
  console.log(tbl(q5rows, ['country_code', 'insider_name', 'cnt']));
  console.log(`  Total groups: ${q5rows.length}\n`);

  // Emit machine-readable data for fix script
  return { q1rows, q2rows, q3rows, q4rows, q5rows };
}

main().then(r => {
  // Write audit results to file for fix script
  require('fs').writeFileSync('/tmp/audit_results.json', JSON.stringify(r, null, 2));
  console.log('\nAudit results written to /tmp/audit_results.json');
  process.exit(0);
}).catch(err => { console.error('Fatal:', err.message); process.exit(1); });
