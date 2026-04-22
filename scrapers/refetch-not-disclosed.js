'use strict';

/**
 * Re-fetch PDFs for rows where insider_name = 'Not disclosed' and extract the
 * real natural person name. Handles France (AMF BDIF) and Italy (eMarket Storage).
 *
 * Run with:  node scrapers/refetch-not-disclosed.js
 * Requires:  SUPABASE_KEY env var (service role or anon key with write access)
 */

const https   = require('https');
const { execSync } = require('child_process');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const { createClient }      = require('@supabase/supabase-js');
const { looksLikeCorp, splitFrPersonLiee } = require('./lib/entityUtils');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_KEY) { console.error('❌ SUPABASE_KEY required'); process.exit(1); }
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function download(url, extraHeaders = {}) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const req = https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          ...extraHeaders,
        },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(download(res.headers.location, extraHeaders));
        }
        if (res.statusCode !== 200) return resolve(null);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function downloadJson(hostname, path_, extraHeaders = {}) {
  return new Promise(resolve => {
    const req = https.get({
      hostname, path: path_,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': `https://${hostname}/`,
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
  });
}

// ── PDF → text ────────────────────────────────────────────────────────────────

let _pdfParse = null;
async function bufferToText(buf) {
  // Try pdftotext (layout-preserving)
  const tmp = path.join(os.tmpdir(), `refetch-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    const t = execSync(`pdftotext -layout "${tmp}" -`, { encoding: 'utf8', timeout: 15000, stdio: ['ignore','pipe','ignore'] });
    if (t && t.length > 100) return t;
  } catch {} finally { try { fs.unlinkSync(tmp); } catch {} }
  // Fallback: pdf-parse (JS, no native dep)
  try {
    if (!_pdfParse) _pdfParse = require('pdf-parse');
    const d = await _pdfParse(buf);
    return d.text || null;
  } catch {}
  return null;
}

// ── France helpers ────────────────────────────────────────────────────────────

/** Extract person name from via_entity strings like "ENTITY personne morale liée à PERSON" */
function personFromViaEntity(ve) {
  if (!ve) return null;
  const m = ve.match(/personne(?:\s+(?:morale|physique))?\s+li[eé]e?\s+[àa]\s+(.+)$/i);
  if (!m) return null;
  const candidate = m[1].trim().replace(/,.*$/, '').trim(); // strip trailing role
  if (candidate.length < 2 || looksLikeCorp(candidate)) return null;
  return candidate;
}

/** Query AMF BDIF API for a single filing's document path by numero */
async function fetchAmfDocPath(numero) {
  // Try numeroConcatene filter
  const qs = `TypesInformation=DD&numeroConcatene=${encodeURIComponent(numero)}&From=0&Size=5`;
  const data = await downloadJson('bdif.amf-france.org', `/back/api/v1/informations?${qs}`, {
    'Accept-Language': 'fr-FR',
  });
  if (!data) return null;
  const items = data.result || [];
  const item = items.find(r => {
    const n = r.numero || r.numeroConcatene || String(r.id || '');
    return n === numero;
  }) || items[0];
  return item?.documents?.[0]?.path || null;
}

/** Parse PDF text for natural person name (France AMF national form) */
function parseFrPdfForPerson(text) {
  if (!text) return null;
  const flat = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

  // Priority 1: explicit "PRÉNOM ET NOM DE LA PERSONNE PHYSIQUE : NAME"
  const physM = flat.match(/PR[EÉ]NOM\s+ET\s+NOM\s+DE\s+LA\s+PERSONNE\s+PHYSIQUE\s*:?\s*([^\n]{2,80})/i);
  if (physM) {
    const n = physM[1].trim().replace(/\s+/g, ' ');
    if (n.length > 2 && !looksLikeCorp(n) && !/^[.\s_]+$/.test(n)) return n;
  }

  // Priority 2: line after "PERSONNE ETROITEMENT LIEE :" label
  const lines = flat.split('\n');
  const labelIdx = lines.findIndex(l => /PERSONNE ETROITEMENT LI/i.test(l));
  if (labelIdx >= 0) {
    const nameLine = lines[labelIdx + 1] || '';
    // Strip trailing role (after last comma)
    const commaIdx = nameLine.lastIndexOf(',');
    const nameOnly = commaIdx > 0 ? nameLine.slice(0, commaIdx).trim() : nameLine;
    // Try splitFrPersonLiee (handles both form layouts including "personne morale liée à")
    const split = splitFrPersonLiee(nameOnly);
    if (split && split.person && !looksLikeCorp(split.person)) return split.person;
    // Also try extracting from via_entity-style string without splitFrPersonLiee
    const person = personFromViaEntity(nameOnly);
    if (person) return person;
  }

  // Priority 3: ESMA form "1 a) Nom / Name\nVALUE"
  const sec1M = flat.match(/(?:^|\n)(?:1\s*[.a)]+\s*)?(?:Nom|Name)\s*\n([A-ZÀ-Öa-zA-ZÀ-ÿ][^\n]{2,60})/m);
  if (sec1M) {
    const n = sec1M[1].trim();
    if (!looksLikeCorp(n) && !/^(?:Full|Prénom|First|Last|Legal|Pour)/i.test(n)) return n;
  }

  return null;
}

// ── Italy helpers ─────────────────────────────────────────────────────────────

/** Parse Italian eMarket Storage PDF for the natural PDMR when entity filed */
function parseItPdfForPdmr(text) {
  if (!text) return null;

  // Oggetto line: "Internal dealing PERSON per conto di ENTITY" or just "Internal dealing PERSON"
  const objM = text.match(/Oggetto\s*:\s*Internal\s+dealing\s+([A-ZÀ-Öa-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ\s\-\.]+?)(?:\s+(?:per\s+conto\s+(?:di|del(?:la)?)|tramite|via)\b|\s*[-–]\s*|\s*\n)/i);
  if (objM) {
    const c = objM[1].trim();
    if (c.length > 2 && !looksLikeCorp(c)) return c;
  }

  // "Closely associated with: PERSON"
  const caM = text.match(/closely\s+associated\s+with\s*:?\s*([A-ZÀ-Ö][a-zA-ZÀ-ÿ\s\-\.]{2,50}?)(?:\n|[,;(])/i);
  if (caM) { const c = caM[1].trim(); if (!looksLikeCorp(c)) return c; }

  // "Strettamente legato/a a: PERSON"
  const slM = text.match(/strettamente\s+leg(?:ato|ata)\s+a\s*:?\s*([A-ZÀ-Ö][a-zA-ZÀ-ÿ\s\-\.]{2,50}?)(?:\n|[,;(])/i);
  if (slM) { const c = slM[1].trim(); if (!looksLikeCorp(c)) return c; }

  // "Per conto di PERSON"
  const pcM = text.match(/per\s+conto\s+(?:di|del(?:la)?)\s+([A-ZÀ-Ö][a-zA-ZÀ-ÿ\s\-\.]+?)(?:\n|[,;(])/i);
  if (pcM) { const c = pcM[1].trim(); if (!looksLikeCorp(c)) return c; }

  return null;
}

// ── France fix ────────────────────────────────────────────────────────────────

async function fixFrance() {
  console.log('\n── France ────────────────────────────────────────────────────────');
  const { data: rows, error } = await db.from('insider_transactions')
    .select('id, filing_id, via_entity, transaction_date')
    .eq('country_code', 'FR').eq('insider_name', 'Not disclosed');
  if (error) { console.error(' ', error.message); return; }
  console.log(`  ${rows.length} rows to fix`);

  let nDirect = 0, nPdf = 0, nSkip = 0;

  for (const row of rows) {
    // Fast path: extract person from via_entity string
    const directName = personFromViaEntity(row.via_entity);
    if (directName) {
      const { error: ue } = await db.from('insider_transactions').update({ insider_name: directName }).eq('id', row.id);
      if (!ue) { console.log(`  ✓ direct  ${directName}  (${row.via_entity?.slice(0, 50)})`); nDirect++; }
      await new Promise(r => setTimeout(r, 80));
      continue;
    }

    // Slow path: fetch PDF from AMF API
    const numero = row.filing_id.replace(/^FR-/, '');
    await new Promise(r => setTimeout(r, 350));
    const docPath = await fetchAmfDocPath(numero);
    if (!docPath) { nSkip++; continue; }

    const buf = await download(`https://bdif.amf-france.org/back/api/v1/documents/${docPath}`, {
      'Accept': 'application/pdf,*/*',
      'Referer': 'https://bdif.amf-france.org/',
    });
    if (!buf || buf.slice(0,4).toString() !== '%PDF') { nSkip++; continue; }

    const text = await bufferToText(buf);
    const personName = parseFrPdfForPerson(text);
    if (!personName) { nSkip++; continue; }

    const { error: ue } = await db.from('insider_transactions').update({ insider_name: personName }).eq('id', row.id);
    if (!ue) { console.log(`  ✓ pdf     ${personName}`); nPdf++; }
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`  Result: ${nDirect} direct, ${nPdf} pdf, ${nSkip} skipped`);
}

// ── Italy fix ─────────────────────────────────────────────────────────────────

async function fixItaly() {
  console.log('\n── Italy ─────────────────────────────────────────────────────────');
  const { data: rows, error } = await db.from('insider_transactions')
    .select('id, filing_id, via_entity, filing_url')
    .eq('country_code', 'IT').eq('insider_name', 'Not disclosed');
  if (error) { console.error(' ', error.message); return; }
  console.log(`  ${rows.length} rows to fix`);

  let nFixed = 0, nSkip = 0;

  for (const row of rows) {
    const pdfUrl = row.filing_url;
    if (!pdfUrl || !pdfUrl.includes('.pdf')) { nSkip++; continue; }

    const buf = await download(pdfUrl);
    if (!buf) { nSkip++; continue; }

    const text = await bufferToText(buf);
    const personName = parseItPdfForPdmr(text);
    if (!personName) {
      console.log(`  ✗ no person found  via=${row.via_entity}  url=${pdfUrl.slice(-40)}`);
      nSkip++; continue;
    }

    const { error: ue } = await db.from('insider_transactions').update({ insider_name: personName }).eq('id', row.id);
    if (!ue) { console.log(`  ✓ ${personName}  via ${row.via_entity}`); nFixed++; }
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`  Result: ${nFixed} fixed, ${nSkip} skipped`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍  Re-fetch "Not disclosed" names — FR + IT');
  await fixFrance();
  await fixItaly();
  console.log('\n✅  Done');
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
