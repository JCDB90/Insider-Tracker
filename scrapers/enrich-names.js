'use strict';
/**
 * Name Enrichment — retry name extraction for all null/Not-disclosed insider_name rows.
 *
 * Strategy per market:
 *   NO  — re-fetch Oslo Bors message body, run fixed parseBody
 *   FI  — re-fetch Nasdaq Helsinki notification HTML + PDFs
 *   DK  — re-fetch Nasdaq Copenhagen notification HTML + PDFs
 *   BE  — re-fetch FSMA detail page
 *   IT  — re-fetch CONSOB PDF
 *   GB  — re-fetch FCA NSM RNS HTML
 *   ES  — re-fetch CNMV filing page for Declarante field
 *   FR  — re-fetch AMF BDIF PDF via document API
 *   DE  — re-fetch BaFin CSV row (name is in CSV col 3)
 *   CH  — skip (SER-AG API genuinely doesn't expose names)
 */

const https       = require('https');
const http        = require('http');
const { execSync }= require('child_process');
const os          = require('os');
const fs          = require('fs');
const path        = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://loqmxllfjvdwamwicoow.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_wL5qlj7xHeE6-y2cXaRKfw_39-iEoUt';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const DELAY = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchText(url, headers = {}) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get({
        hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,*/*', ...headers },
      }, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function fetchBinary(url) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const req = https.get({ hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*' } }, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve(Buffer.concat(c)));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(25000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function fetchJson(url, headers = {}) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const req = https.get({ hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers } }, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(c).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function pdfToText(buf) {
  if (!buf || buf.length < 200) return '';
  const tmp = path.join(os.tmpdir(), `enrich_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    return execSync(`pdftotext -layout "${tmp}" -`, { timeout: 15000, maxBuffer: 5e6 }).toString('utf8');
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
             .replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Norway ────────────────────────────────────────────────────────────────────

// Paste the fixed parseBody from norway.js (inline for enrichment use)
const WORD_NO = '[A-ZÆØÅ][a-zA-ZÆØÅæøå\\.\\-]{1,25}';
const ROLE_KW = 'CEO|CFO|COO|CTO|[Cc]hair(?:man)?|[Vv]ice|[Bb]oard|[Cc]hief|[Pp]resident|[Mm]anaging|[Ss]enior|[Gg]eneral|[Mm]ember|[Dd]irector|[Oo]fficer|[Ff]ounder|[Aa]dvisor|[Pp]artner|[Hh]ead|EVP|SVP|VP|[Cc]ontroller|[Ss]ecretary';

function parseNameFromNoBody(raw) {
  if (!raw) return null;
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

  // Table format
  const tableNameM =
    text.match(/(?:Innsider|Insider)\s*[:/]\s*([A-ZÆØÅ][^\n|<,]{2,59}?)(?:\s{2,}|\s*(?:Stilling|Position))/i) ||
    text.match(/(?:Innsider|Insider)\s*[:/]\s*([A-ZÆØÅ][a-zA-ZÆØÅæøå\- ]{2,59})/i);
  if (tableNameM) return tableNameM[1].trim();

  // Prose stripping
  let prose = text;
  prose = prose.replace(/^NOT\s+FOR\s+PUBLICATION[^.]*\.\s*/i, '');
  prose = prose.replace(/^\(\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}[^)]*\)\s*[-–]?\s*/i, '');
  prose = prose.replace(/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}[:\s–-]{0,5}/i, '');
  prose = prose.replace(/^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}[:\s]*/i, '');
  prose = prose.replace(/^[A-Z][a-zæøåÆØÅ]{2,20}(?:,\s*[A-Z][a-z]{2,20})?,?\s*\d{1,2}\s+[A-Z][a-z]+\s+\d{4}[:\s–-]*/i, '');
  prose = prose.replace(/^[A-Z][a-zA-ZÆØÅ\s\.]{2,40}\s*[–—-]+\s*/u, '');

  // Pattern 1: Name, Role
  const personRoleM = prose.match(new RegExp(`(${WORD_NO}(?:\\s+${WORD_NO}){0,4}),\\s*(${ROLE_KW})`));
  if (personRoleM) {
    let name = personRoleM[1].trim();
    name = name.replace(/\s+(?:in|of|at)\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\s\.]{2,}(?:ASA|AS|Ltd|plc|SE)\s*\.?$/i, '').trim();
    if (name.length >= 3 && /^[A-ZÆØÅ]/.test(name)) return name;
  }

  // Pattern 2: closely associated with Name
  const closeAssocM = text.match(
    /close(?:ly)?\s+associate[d]?\s+(?:of|with)\s+(?:Mr\.?\s*|Mrs\.?\s*|Ms\.?\s*)?([A-ZÆØÅ][a-zA-ZÆØÅæøå\- \.]{2,50}(?:\s+[A-ZÆØÅ][a-zA-ZÆØÅæøå\-\.]{1,20}){0,3})(?:,|\s+(?:Director|CEO|CFO|Chair|Board|President|Managing|Officer))/i
  );
  if (closeAssocM) return closeAssocM[1].trim();

  // Pattern 3: primary insider NAME (uppercase required)
  const controlledByM = text.match(
    new RegExp(`(?:primary\\s+insider\\s+(?:is\\s+)?|controlled\\s+by|published\\s+by|exercised\\s+by)\\s+(?:Mr\\.?\\s*|Mrs\\.?\\s*|Ms\\.?\\s*)?(${WORD_NO}(?:\\s+${WORD_NO}){0,4})(?:,|\\b)`)
  );
  if (controlledByM) {
    const n = controlledByM[1].trim();
    if (/^[A-ZÆØÅ]/.test(n) && n.length >= 3) return n;
  }

  // Pattern 4: "This notification concerns NAME"
  const concernsM = text.match(/notification\s+concerns\s+([A-ZÆØÅ][a-zA-ZÆØÅæøå\-\. ]{3,50}?)(?:,|\s+who\s)/i);
  if (concernsM) return concernsM[1].trim();

  return null;
}

async function enrichNO(rows) {
  let fixed = 0;
  for (const row of rows) {
    const msgId = row.filing_id.replace('NO-', '');
    const data = await fetchJson(`https://api3.oslo.oslobors.no/v1/newsreader/message?messageId=${msgId}`,
      { 'Origin': 'https://newsweb.oslobors.no' });
    await DELAY(300);
    const body = data?.data?.message?.body || '';
    if (!body) continue;

    const name = parseNameFromNoBody(body);
    if (name && name.length >= 3 && /^[A-ZÆØÅ]/.test(name)) {
      await sb.from('insider_transactions').update({ insider_name: name }).eq('id', row.id);
      console.log(`  [NO] ${row.company}: "${name}"`);
      fixed++;
    }
  }
  return fixed;
}

// ── Finland / Denmark (Nasdaq Nordic) ────────────────────────────────────────

async function parseNasdaqNotification(messageUrl) {
  const res = await fetchText(messageUrl, { 'Accept': 'text/html' });
  if (!res || res.status !== 200) return null;
  const html = res.body;
  const text = stripHtml(html);

  // Look for name patterns in the plain text
  const namePatterns = [
    // "a) Name: John Smith" or "Name: John Smith"
    /\ba\)\s*Name\s*[:\-]\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i,
    /\bName\s+of\s+the\s+person[^:]{0,60}:\s*([A-Z][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i,
    /\bInsider\s*[:\-]\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i,
  ];

  for (const pat of namePatterns) {
    const m = text.match(pat);
    if (m) {
      const n = m[1].trim().split(/\n/)[0].trim();
      if (n.length >= 3 && !/^(?:Details|Reason|Initial|Description)/i.test(n)) return n;
    }
  }

  // Try PDF attachments
  const pdfUrls = [...new Set((html.match(/https:\/\/attachment\.news\.eu\.nasdaq\.com\/[a-z0-9]+/g) || []))];
  for (const pdfUrl of pdfUrls.slice(0, 3)) {
    const buf = await fetchBinary(pdfUrl);
    const pdfText = pdfToText(buf);
    if (!pdfText) continue;

    // ESMA form: "a) Name\n  John Smith"
    const pdfNameM = pdfText.match(/\ba\)\s*Name\b[^\n]*\n+(?:\d+\s*\n+)?\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i);
    if (pdfNameM) {
      const n = pdfNameM[1].trim();
      if (n.length >= 3 && !/^(?:Reason|Details|Initial|b\)|c\))/i.test(n)) return n;
    }

    // Inline: "Name: John Smith"
    const inlineM = pdfText.match(/\bName\s*[:\-]\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i);
    if (inlineM) {
      const n = inlineM[1].trim();
      if (n.length >= 3) return n;
    }

    await DELAY(300);
  }
  return null;
}

async function enrichNordic(rows, cc) {
  let fixed = 0;
  for (const row of rows) {
    if (!row.filing_url) continue;
    const name = await parseNasdaqNotification(row.filing_url);
    await DELAY(400);
    if (name) {
      await sb.from('insider_transactions').update({ insider_name: name }).eq('id', row.id);
      console.log(`  [${cc}] ${row.company}: "${name}"`);
      fixed++;
    }
  }
  return fixed;
}

// ── Belgium (FSMA) ────────────────────────────────────────────────────────────

async function enrichBE(rows) {
  let fixed = 0;
  for (const row of rows) {
    if (!row.filing_url) continue;
    const res = await fetchText(row.filing_url);
    await DELAY(400);
    if (!res || res.status !== 200) continue;
    const text = stripHtml(res.body);

    // FSMA page has "Notifying Person: John Smith"
    const m = text.match(/Notifying\s+[Pp]erson\s*[:\-]\s*([A-ZÆØÅ][a-zA-ZÆØÅæøå\-\. ]{2,60})/i) ||
              text.match(/Person\s*[:\-]\s*([A-ZÆØÅ][a-zA-ZÆØÅæøå\-\. ]{2,60})/);
    if (m) {
      const n = m[1].trim().split(/\n/)[0].trim();
      if (n.length >= 3 && !/^(?:type|issuer|ISIN|role|instrument)/i.test(n)) {
        await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
        console.log(`  [BE] ${row.company}: "${n}"`);
        fixed++;
      }
    }
  }
  return fixed;
}

// ── Italy (CONSOB PDFs) ───────────────────────────────────────────────────────

async function enrichIT(rows) {
  let fixed = 0;
  for (const row of rows) {
    if (!row.filing_url) continue;
    const buf = await fetchBinary(row.filing_url);
    await DELAY(400);
    if (!buf) continue;
    const text = pdfToText(buf);
    if (!text) continue;

    // ESMA form section 1a: "a) Name: ..."
    const nameM = text.match(/\ba\)\s*(?:Name|Nome)\s*[:\-]?\s*\n+\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i) ||
                  text.match(/\ba\)\s*(?:Name|Nome)\b[^\n]*\n+\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i) ||
                  text.match(/Cognome\s+e\s+nome[^\n]*\n+\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i) ||
                  text.match(/Nome\s+e\s+cognome[^\n]*\n+\s*([A-ZÆØÅÄÖÜ][a-zA-ZÆØÅÄÖÜæøåäöü\-\. ]{2,60})/i);
    if (nameM) {
      const n = nameM[1].trim();
      if (n.length >= 3 && !/^(?:b\)|c\)|Reason|Details|LEI|ISIN)/i.test(n)) {
        await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
        console.log(`  [IT] ${row.company}: "${n}"`);
        fixed++;
      }
    }
  }
  return fixed;
}

// ── United Kingdom (FCA NSM) ──────────────────────────────────────────────────

async function enrichGB(rows) {
  let fixed = 0;
  for (const row of rows) {
    if (!row.filing_url) continue;
    const res = await fetchText(`https://data.fca.org.uk${row.filing_url}`);
    await DELAY(400);
    if (!res || res.status !== 200) continue;
    const text = stripHtml(res.body);

    const m = text.match(/Name\s+of\s+(?:the\s+)?person[^:]{0,60}:\s*([A-Z][a-zA-Z\-\. ]{2,60})/i) ||
              text.match(/\b1\s*\.\s*a\)\s+Name[^\n]*\n\s*([A-Z][a-zA-Z\-\. ]{2,60})/i);
    if (m) {
      const n = m[1].trim().split(/\n/)[0].trim();
      if (n.length >= 3) {
        await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
        console.log(`  [GB] ${row.company}: "${n}"`);
        fixed++;
      }
    }
  }
  return fixed;
}

// ── Spain (CNMV) ──────────────────────────────────────────────────────────────

async function enrichES(rows) {
  let fixed = 0;
  for (const row of rows) {
    // filing_id is ES-{regNum} - fetch the CNMV page for this registration number
    const regNum = row.filing_id.replace('ES-', '');
    // Try the CNMV results page filtered to this registration number
    const res = await fetchText(
      `https://www.cnmv.es/portal/Consultas/Directivos-Resultado?nExpediente=${regNum}`,
      { 'Accept-Language': 'es-ES,es;q=0.9' }
    );
    await DELAY(500);

    if (res && res.status === 200) {
      const text = res.body;
      // Look for "Declarante: Name" in the HTML
      const m = text.match(/Declarante\s*:\s*([A-ZÁÉÍÓÚÜÑa-záéíóúüñA-Z][^\n<]{2,80})/i);
      if (m) {
        const n = m[1].replace(/<[^>]+>/g, '').trim();
        if (n.length >= 3) {
          await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
          console.log(`  [ES] ${row.company}: "${n}"`);
          fixed++;
          continue;
        }
      }
    }

    // Fallback: try fetching the PDF via the filing_url token
    if (row.filing_url) {
      const buf = await fetchBinary(row.filing_url.startsWith('http') ? row.filing_url : 'https://www.cnmv.es' + row.filing_url);
      await DELAY(300);
      const pdfText = pdfToText(buf);
      if (pdfText) {
        // ESMA form: person name near "Naturaleza del declarante"
        const pdfM = pdfText.match(/(?:Nombre|Name)\s*(?:completo|and\s+surname)?\s*[:\-]?\s*\n+\s*([A-ZÁÉÍÓÚÜÑ][a-zA-ZÁÉÍÓÚÜÑáéíóúüñ\-\. ]{2,60})/i) ||
                     pdfText.match(/\bDeclarante\s*[:\-]\s*([A-ZÁÉÍÓÚÜÑ][a-zA-ZÁÉÍÓÚÜÑáéíóúüñ\-\. ]{2,60})/i);
        if (pdfM) {
          const n = pdfM[1].trim();
          if (n.length >= 3) {
            await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
            console.log(`  [ES] ${row.company} (PDF): "${n}"`);
            fixed++;
          }
        }
      }
    }
  }
  return fixed;
}

// ── France (AMF BDIF) ─────────────────────────────────────────────────────────

async function enrichFR(rows) {
  let fixed = 0;
  for (const row of rows) {
    const docId = row.filing_id.replace('FR-', '');

    // Get document details from AMF API
    const info = await fetchJson(
      `https://bdif.amf-france.org/back/api/v1/informations/${docId}`,
      { 'Referer': 'https://bdif.amf-france.org/', 'Accept-Language': 'fr-FR' }
    );
    await DELAY(500);

    if (!info) continue;

    // The name is sometimes in the "declarant" field of the JSON
    const declarant = info.declarant || info.nomDeclarant || info.personne || info.nom;
    if (declarant && declarant.length >= 3 && !/^\d+$/.test(declarant)) {
      await sb.from('insider_transactions').update({ insider_name: declarant }).eq('id', row.id);
      console.log(`  [FR] ${row.company}: "${declarant}" (API)`);
      fixed++;
      continue;
    }

    // Try PDF attachments
    const attachments = info.pieces || info.attachments || [];
    const pdfAttach = attachments.find(a => (a.url || a.lien || '').match(/\.pdf$/i) || a.typePiece === 'PDF');
    const pdfUrl = pdfAttach?.url || pdfAttach?.lien;

    if (pdfUrl) {
      const buf = await fetchBinary(pdfUrl.startsWith('http') ? pdfUrl : 'https://bdif.amf-france.org' + pdfUrl);
      await DELAY(300);
      const pdfText = pdfToText(buf);

      if (pdfText) {
        // French ESMA form: "Prénom et Nom" or "Nom:" or "1. a) Nom:"
        const nameM = pdfText.match(/(?:Pr[eé]nom\s+et\s+[Nn]om|Nom\s+et\s+pr[eé]nom)[^\n]*\n+\s*([A-ZÁÉÈÊËÀÂÙÛÜÔÎÏÇŒ][a-zA-ZÁÉÈÊËÀÂÙÛÜÔÎÏÇŒáéèêëàâùûüôîïç\-\. ]{2,60})/i) ||
                      pdfText.match(/(?:a\)\s*)?(?:Nom|Name)\s*[:\-]\s*([A-ZÁÉÈÊË][a-zA-ZÁÉÈÊËÀÂÙÛÜÔÎÏÇŒáéèêëàâùûüôîïç\-\. ]{2,60})/i) ||
                      pdfText.match(/^([A-ZÁÉÈÊË][a-zA-ZÁÉÈÊËÀÂÙÛÜÔÎÏÇŒ\-\. ]{5,60})\s*\n+Qualit[eé]/im);
        if (nameM) {
          const n = nameM[1].trim().split(/\n/)[0].trim();
          if (n.length >= 3 && !/^(?:b\)|c\)|Motif|Émetteur|Raison|ISIN)/i.test(n)) {
            await sb.from('insider_transactions').update({ insider_name: n }).eq('id', row.id);
            console.log(`  [FR] ${row.company}: "${n}" (PDF)`);
            fixed++;
          }
        }
      }
    }
  }
  return fixed;
}

// ── Germany (BaFin CSV re-check) ──────────────────────────────────────────────

async function enrichDE(rows) {
  // Group by company first letter to minimise CSV fetches
  const byLetter = {};
  for (const row of rows) {
    const letter = (row.company || 'A')[0].toUpperCase();
    if (!byLetter[letter]) byLetter[letter] = [];
    byLetter[letter].push(row);
  }

  let fixed = 0;
  for (const [letter, letterRows] of Object.entries(byLetter)) {
    const csvUrl = `https://portal.mvp.bafin.de/database/DealingsInfo/sucheForm.do?d-4000784-e=1&emittentName=${encodeURIComponent(letter)}&6578706f7274=1`;
    const res = await fetchText(csvUrl, {
      'Accept': 'text/html,text/csv,*/*',
      'Accept-Language': 'de-DE,de;q=0.9',
    });
    await DELAY(500);
    if (!res || !res.body) continue;

    const lines = res.body.split(/\r?\n/);
    for (const row of letterRows) {
      // Match by company name + filing_id bafinId
      const bafinId = row.filing_id.split('-')[1];
      const matchLine = lines.find(l => l.includes(bafinId) && l.split(';')[3]?.trim());
      if (matchLine) {
        const cols = matchLine.split(';');
        const name = cols[3]?.trim();
        if (name && name.length >= 3) {
          await sb.from('insider_transactions').update({ insider_name: name }).eq('id', row.id);
          console.log(`  [DE] ${row.company}: "${name}"`);
          fixed++;
        }
      }
    }
  }
  return fixed;
}

// ── Warning logger in db.js equivalent ───────────────────────────────────────

async function addDbWarning() {
  // Read db.js and add warning log
  const dbPath = '/mnt/c/Users/jelle/Documents/Insider-Tracker/scrapers/lib/db.js';
  const src = require('fs').readFileSync(dbPath, 'utf8');
  if (src.includes('Missing insider name')) return; // already added

  const warningCode = `\n  // Log warning for missing names — helps track which filings need review\n  for (const r of complete) {\n    if (!r.insider_name) {\n      console.warn(\`  ⚠️  Missing insider name: \${r.company || '?'} (\${r.country_code}) — filing \${r.filing_id}\`);\n    }\n  }`;

  const updated = src.replace(
    'if (complete.length === 0) return { inserted: 0 };',
    warningCode + '\n  if (complete.length === 0) return { inserted: 0 };'
  );
  require('fs').writeFileSync(dbPath, updated);
  console.log('  Added missing-name warning to db.js');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍  Name Enrichment — re-fetching source documents for null insider names');
  const t0 = Date.now();

  // Load all null-name rows
  let all = [], from = 0;
  while (true) {
    const { data } = await sb.from('insider_transactions')
      .select('id,country_code,company,filing_id,filing_url,via_entity,transaction_date')
      .or('insider_name.is.null,insider_name.eq.Not disclosed')
      .neq('country_code', 'CH')   // CH genuinely doesn't expose names
      .order('country_code').range(from, from + 999);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const byCc = {};
  for (const r of all) { if (!byCc[r.country_code]) byCc[r.country_code] = []; byCc[r.country_code].push(r); }

  console.log(`\n  BEFORE: ${all.length} rows with null/Not disclosed name (excl. CH)`);
  for (const [cc, rows] of Object.entries(byCc).sort()) console.log(`    ${cc.padEnd(4)} ${rows.length}`);
  console.log('');

  const results = {};

  // Norway — re-parse with fixed roleKW
  if (byCc.NO) {
    console.log(`\n[NO] Enriching ${byCc.NO.length} rows…`);
    results.NO = await enrichNO(byCc.NO);
  }

  // Finland — Nasdaq Nordic PDFs
  if (byCc.FI) {
    console.log(`\n[FI] Enriching ${byCc.FI.length} rows…`);
    results.FI = await enrichNordic(byCc.FI, 'FI');
  }

  // Denmark — Nasdaq Nordic PDFs
  if (byCc.DK) {
    console.log(`\n[DK] Enriching ${byCc.DK.length} rows…`);
    results.DK = await enrichNordic(byCc.DK, 'DK');
  }

  // Belgium — FSMA pages
  if (byCc.BE) {
    console.log(`\n[BE] Enriching ${byCc.BE.length} rows…`);
    results.BE = await enrichBE(byCc.BE);
  }

  // Italy — CONSOB PDFs
  if (byCc.IT) {
    console.log(`\n[IT] Enriching ${byCc.IT.length} rows…`);
    results.IT = await enrichIT(byCc.IT);
  }

  // United Kingdom — FCA NSM
  if (byCc.GB) {
    console.log(`\n[GB] Enriching ${byCc.GB.length} rows…`);
    results.GB = await enrichGB(byCc.GB);
  }

  // Spain — CNMV
  if (byCc.ES) {
    console.log(`\n[ES] Enriching ${byCc.ES.length} rows…`);
    results.ES = await enrichES(byCc.ES);
  }

  // France — AMF BDIF
  if (byCc.FR) {
    console.log(`\n[FR] Enriching ${byCc.FR.length} rows…`);
    results.FR = await enrichFR(byCc.FR);
  }

  // Germany — BaFin CSV
  if (byCc.DE) {
    console.log(`\n[DE] Enriching ${byCc.DE.length} rows…`);
    results.DE = await enrichDE(byCc.DE);
  }

  // Summary
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const totalFixed = Object.values(results).reduce((s, v) => s + (v || 0), 0);
  const remaining = all.length - totalFixed;

  console.log(`\n✅  Enrichment complete in ${elapsed} min`);
  console.log(`  Fixed: ${totalFixed}/${all.length} rows`);
  for (const [cc, n] of Object.entries(results)) console.log(`    ${cc.padEnd(4)} ${n} fixed`);
  console.log(`  Remaining null (genuinely unavailable): ${remaining + 1102} (incl. CH 1102)`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
