/**
 * FR — Insider Transactions Scraper
 *
 * Source: AMF France — BDIF (Base des décisions et informations financières)
 * API:    https://bdif.amf-france.org/back/api/v1/informations
 *
 * The BDIF frontend is an Angular SPA. The /back/ prefix serves the REST API.
 * Discovered by reverse-engineering chunk-KJITPICD.js from the Angular bundle.
 *
 * TypesInformation=DD → Déclarations Dirigeants (MAR Article 19 manager filings)
 * Date parameters: ISO 8601 (YYYY-MM-DDTHH:mm:ss.000Z)
 * Pagination: From=<offset>&Size=<count>
 *
 * Note: The API returns metadata only (no structured transaction data — no
 * insider name, amounts, or transaction type). The PDF attachment contains
 * the full MAR Form but requires parsing. We save available metadata:
 * filing_id, company, date. Transaction details remain null.
 *
 * Note: /Registre-BDIF/ paths return 500 (Struts2 backend broken); /back/ works.
 */
'use strict';

const https   = require('https');
const { execSync } = require('child_process');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');

const COUNTRY_CODE   = 'FR';
const SOURCE         = 'AMF France / BDIF';
const RETENTION_DAYS = 14;
const CURRENCY       = 'EUR';
const PAGE_SIZE      = 100;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function toApiDate(d) {
  return `${isoDate(d)}T00:00:00.000Z`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

function fetchPage(fromApi, toApi, from) {
  return new Promise((resolve) => {
    const qs = [
      `TypesInformation=DD`,
      `DateDebut=${encodeURIComponent(fromApi)}`,
      `DateFin=${encodeURIComponent(toApi)}`,
      `From=${from}`,
      `Size=${PAGE_SIZE}`,
    ].join('&');

    const req = https.get({
      hostname: 'bdif.amf-france.org',
      path: `/back/api/v1/informations?${qs}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'fr-FR',
        'Referer': 'https://bdif.amf-france.org/',
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
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

/**
 * Download a PDF from the AMF BDIF documents API.
 * The PDF path comes from r.documents[0].path in the list response.
 * URL format: /back/api/v1/documents/{path}  (slashes NOT encoded)
 */
function downloadPdf(docPath) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'bdif.amf-france.org',
      path: `/back/api/v1/documents/${docPath}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://bdif.amf-france.org/',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        const buf = Buffer.concat(chunks);
        if (buf.length < 8 || buf.slice(0, 4).toString() !== '%PDF') return resolve(null);
        resolve(buf);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Convert a PDF Buffer to plain text using pdftotext (poppler-utils).
 * Returns null if pdftotext is unavailable or extraction fails.
 */
function pdfToText(buffer) {
  const tmp = path.join(os.tmpdir(), `amf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buffer);
    return execSync(`pdftotext -layout "${tmp}" -`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Parse text from a French AMF national declaration form (not the EU ESMA template).
 *
 * Actual field labels observed in the wild:
 *   NOM /FONCTION DE LA PERSONNE EXERCANT DES RESPONSABILITES DIRIGEANTES
 *   OU DE LA PERSONNE ETROITEMENT LIEE :
 *     → next non-empty line: "<Name>, <Role>"  e.g. "Jean DUPONT, Directeur général"
 *
 *   NATURE DE LA TRANSACTION : Acquisition | Cession
 *   PRIX UNITAIRE : 32.8000 Euro
 *   INFORMATIONS AGREGEES → VOLUME : 50.0000   (total shares across all sub-operations)
 */
function parseFrPdf(text) {
  if (!text || typeof text !== 'string') return {};

  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const flat  = lines.join('\n');

  function grab(patterns) {
    for (const re of patterns) {
      const m = flat.match(re);
      if (m?.[1]?.trim()) return m[1].trim();
    }
    return null;
  }

  function parseNum(s) {
    if (!s) return null;
    const clean = s.toString()
      .replace(/[\s\u00a0]/g, '')
      .replace(/[€EuroURI]/g, '')
      .replace(',', '.')
      .replace(/[^0-9.]/g, '');
    const n = parseFloat(clean);
    return isNaN(n) || n <= 0 ? null : n;
  }

  // ── Insider name + role ───────────────────────────────────────────────────
  // The label spans two lines; the value is the next non-empty line after it.
  // "PERSONNE ETROITEMENT LIEE :" ends the label block.
  const nameLineIdx = lines.findIndex(l => /PERSONNE ETROITEMENT LI/i.test(l));
  const nameLine    = nameLineIdx >= 0 ? lines[nameLineIdx + 1] || null : null;

  let insiderName = null;
  let roleRaw     = null;
  if (nameLine) {
    // Value format: "NAME, Role"  or  "NAME personne liée à OTHER, Role"
    // Split at last comma to separate role
    const commaIdx = nameLine.lastIndexOf(',');
    if (commaIdx > 0) {
      insiderName = nameLine.slice(0, commaIdx).trim();
      roleRaw     = nameLine.slice(commaIdx + 1).trim();
    } else {
      insiderName = nameLine;
    }
  }

  // ── Transaction type ──────────────────────────────────────────────────────
  const txTypeRaw = grab([
    /NATURE DE LA TRANSACTION\s*:\s*(.{2,60})/im,
    /TYPE DE TRANSACTION\s*:\s*(.{2,60})/im,
  ]);

  let txType = 'UNKNOWN';
  if (txTypeRaw) {
    const lo = txTypeRaw.toLowerCase();
    if (lo.includes('acquisit') || lo.includes('achat') ||
        lo.includes('souscri')  || lo.includes('exercice')) txType = 'BUY';
    else if (lo.includes('cession') || lo.includes('vente') ||
             lo.includes('dispos')  || lo.includes('transfert')) txType = 'SELL';
  }

  // ── Price ─────────────────────────────────────────────────────────────────
  // Prefer PRIX UNITAIRE; fall back to PRIX in the aggregated section.
  const priceRaw = grab([
    /PRIX UNITAIRE\s*:\s*(\d[\d.,]+)/im,
    /PRIX\s*:\s*(\d[\d.,]+)/im,
  ]);

  // ── Volume (aggregated total shares) ─────────────────────────────────────
  // Use the LAST occurrence of VOLUME (under INFORMATIONS AGREGEES).
  // Also try QUANTITE / NOMBRE DE TITRES as fallback labels.
  const allVolumes = [...flat.matchAll(/VOLUME\s*:\s*(\d[\d\s.,]+)/gim)];
  let sharesRaw    = allVolumes.length > 0
    ? allVolumes[allVolumes.length - 1][1].replace(/\s/g, '')
    : grab([
        /QUANTIT[EÉ]\s*:\s*(\d[\d\s.,]+)/im,
        /NOMBRE DE TITRES\s*:\s*(\d[\d\s.,]+)/im,
        /NOMBRE D'(?:ACTIONS|INSTRUMENTS)\s*:\s*(\d[\d\s.,]+)/im,
      ]);

  return {
    txType,
    insiderName: insiderName || null,
    role:        roleRaw     || null,
    shares:      parseNum(sharesRaw),
    price:       parseNum(priceRaw),
  };
}

async function scrapeFR() {
  console.log('🇫🇷  AMF France — BDIF Déclarations Dirigeants (MAR Article 19)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  const fromApi = toApiDate(co);
  const toApi   = toApiDate(new Date());
  console.log(`  Fetching ${from} → ${to}…`);

  const allItems = [];
  let offset = 0;
  let total  = null;
  const MAX_PAGES = 50;
  let page = 0;

  while (page < MAX_PAGES) {
    const data = await fetchPage(fromApi, toApi, offset);
    if (!data) {
      if (offset === 0) {
        console.log('  ⚠  AMF BDIF API not accessible.');
        console.log('  ℹ  0 rows saved.');
        return { saved: 0 };
      }
      break;
    }

    const items = data.result || [];
    if (!items.length) break;

    if (total === null) {
      total = data.total;
      console.log(`  Total from API: ${total} items`);
    }

    allItems.push(...items);

    if (allItems.length >= total || items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    page++;
  }

  if (!allItems.length) {
    console.log('  No DD filings found.');
    return { saved: 0 };
  }

  // Check pdftotext availability (installed via poppler-utils in CI workflow)
  let hasPdfToText = false;
  try { execSync('pdftotext -v', { stdio: 'ignore' }); hasPdfToText = true; } catch {}
  if (!hasPdfToText) {
    console.log('  ⚠  pdftotext not found — install poppler-utils for full PDF parsing.');
    console.log('  ℹ  0 rows saved (BUY/SELL type is only in PDF attachments).');
    return { saved: 0 };
  }
  console.log(`  pdftotext available — will parse ${allItems.length} PDF attachments`);

  const seen   = new Set();
  const dbRows = [];
  let nPdf = 0, nParsed = 0, nSkipped = 0;

  for (const r of allItems) {
    const numero = r.numero || r.numeroConcatene || String(r.id || '');
    const fid    = `FR-${numero}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const txIso     = (r.dateInformation || r.datePublication || '').slice(0, 10) || from;
    const company   = r.societes?.length > 0 ? r.societes[0].raisonSociale : null;
    const filingUrl = `https://bdif.amf-france.org/Registre-BDIF/Resultat-de-recherche?docId=${numero}`;

    // ── Get PDF path from list response (already included as r.documents[0]) ─
    // URL: /back/api/v1/documents/{path}  — slashes are NOT percent-encoded
    const docPath = r.documents?.[0]?.path;
    if (!docPath) { nSkipped++; continue; }

    await new Promise(res => setTimeout(res, 300)); // rate-limit AMF API

    // ── Download PDF ─────────────────────────────────────────────────────────
    const pdfBuf = await downloadPdf(docPath);
    if (!pdfBuf) { nSkipped++; continue; }
    nPdf++;

    // ── Extract and parse text ───────────────────────────────────────────────
    const text   = pdfToText(pdfBuf);
    const parsed = parseFrPdf(text);

    if (parsed.txType === 'UNKNOWN') { nSkipped++; continue; }
    nParsed++;

    const shares = parsed.shares ? Math.round(parsed.shares) : null;
    const price  = parsed.price  || null;

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker:           null,
      company,
      insider_name:     parsed.insiderName || 'Not disclosed',
      insider_role:     translateRole(parsed.role) || null,
      transaction_type: parsed.txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      (shares && price) ? Math.round(shares * price) : null,
      currency:         CURRENCY,
      filing_url:       filingUrl,
      source:           SOURCE,
    });
  }

  console.log(`  PDFs downloaded: ${nPdf} | Parsed BUY/SELL: ${nParsed} | Skipped: ${nSkipped}`);

  if (!dbRows.length) {
    console.log('  No BUY/SELL transactions found in PDFs.');
    return { saved: 0 };
  }

  // Preview
  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares ?? 'n/a'} @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeFR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
