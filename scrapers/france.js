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
const { splitFrPersonLiee }       = require('./lib/entityUtils');
const { isinToTicker }            = require('./lib/isinToTicker');
const { contentId }               = require('./lib/contentId');

const COUNTRY_CODE   = 'FR';
const SOURCE         = 'AMF France / BDIF';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
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

// Title-keyword patterns used ONLY to locate the matched span within a raw
// FR role string, so leftover text around it (a subsidiary, region, or
// functional qualifier) can be preserved instead of silently discarded.
// Mirrors the FR-specific entries in lib/translate.js's ROLE_RULES, in the
// same specific-before-generic order — keep both lists in sync if the FR
// patterns there change.
const FR_TITLE_SPAN_PATTERNS = [
  /pr[eé]sident.directeur\s+g[eé]n[eé]ral[e]?/i,
  /\bPDG\b/i,
  /direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?\s+d[eé]l[eé]gu[eé][e]?/i,
  /direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?\s+adjoint[e]?/i,
  /\bDGA\b/, /\bDGD\b/,
  /direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?/i,
  /\bDG\b/,
  /chief\s+executive\s+officer/i, /\bCEO\b/,
  /chief\s+financial\s+officer/i, /\bCFO\b/,
  /chief\s+operating\s+officer/i, /\bCOO\b/,
];

/**
 * Resolve a raw FR role string to its canonical label, preserving any extra
 * context around the matched title as a parenthetical qualifier instead of
 * letting translateRole() silently collapse the whole string to a bare
 * label. Confirmed live (2026-08-05): Publicis Groupe SA's Nigel Vaz has
 * "CEO Publicis Sapient" (a subsidiary) on his own AMF filing — bare
 * translateRole() maps this straight to 'CEO', indistinguishable from Arthur
 * Sadoun's actual group-level "CEO" and reproducing the exact "multiple
 * people all showing CEO for one company" problem this file's role-mapping
 * fix already addressed once for the DG/PDG distinction. Same for Unibail's
 * "Membre du Directoire, Directrice Générale Stratégie Client et Commerce"
 * and 74Software's "74Software, CEO Axway" (both reach here as one combined
 * string after the comma-split fix above).
 *
 * When no FR title pattern matches, falls back to plain translateRole() —
 * unchanged behavior for clean single-title strings (e.g. bare "PDG",
 * "Directeur Général") and for non-title pass-through text (e.g. "DDD",
 * "D.G. d'une filiale : Thermador SAS", which already correctly carries its
 * own qualifier in a form no title pattern matches anyway).
 */
function resolveFrRole(roleRaw) {
  if (!roleRaw) return null;
  for (const re of FR_TITLE_SPAN_PATTERNS) {
    const m = roleRaw.match(re);
    if (!m) continue;
    const canonical = translateRole(m[0]);
    const leftover = (roleRaw.slice(0, m.index) + roleRaw.slice(m.index + m[0].length))
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return leftover ? `${canonical} (${leftover})` : canonical;
  }
  return translateRole(roleRaw);
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
  let viaEntity   = null;
  let roleRaw     = null;
  if (nameLine) {
    // Value format: "NAME, Role"  or  "NAME personne liée à ENTITY, Role" —
    // but some filers pack MULTIPLE comma-separated role/context fragments
    // into this field, e.g. Unibail's "Anne-Sophie SANCERRE, Membre du
    // Directoire, Directrice Générale Stratégie Client et Commerce" or
    // 74Software's "Roland ROYER, 74Software, CEO Axway". Splitting at the
    // LAST comma (as this used to) keeps the first role fragment stuck to
    // the name ("Anne-Sophie SANCERRE, Membre du Directoire" as the "name")
    // and throws away everything but the final fragment as the role.
    // Splitting at the FIRST comma instead correctly isolates the name in
    // every case seen so far — a person's own name has never contained a
    // comma in this dataset — and keeps ALL subsequent fragments together as
    // one combined role string, so resolveFrRole() below has the full
    // context to work with instead of a truncated fragment.
    const commaIdx = nameLine.indexOf(',');
    if (commaIdx > 0) {
      insiderName = nameLine.slice(0, commaIdx).trim();
      roleRaw     = nameLine.slice(commaIdx + 1).trim();
    } else {
      // No comma — strip known role keywords appended to name
      const roleKwRe = /\s+(?:DIRECTEUR|DIRECTRICE|PRÉSIDENT|PRÉSIDENTE|PDG|P-DG|CEO|CFO|COO|ADMINISTRATEUR|ADMINISTRATRICE|MEMBRE DU CONSEIL|VICE[- ]?PRÉSIDENT|SECRÉTAIRE GÉNÉRAL)\b.*/i;
      const roleKwM = nameLine.match(roleKwRe);
      if (roleKwM) {
        insiderName = nameLine.slice(0, roleKwM.index).trim();
        roleRaw     = roleKwM[0].trim();
      } else {
        insiderName = nameLine;
      }
    }
    // Split "NAME personne liée à ENTITY" into person + via_entity. roleRaw is
    // passed through so a family-relation-term role (e.g. "Epouse Guillaume
    // Robin") can be detected and the person/entity assignment swapped — see
    // splitFrPersonLiee's doc comment.
    if (insiderName) {
      const liee = splitFrPersonLiee(insiderName, roleRaw);
      if (liee) { insiderName = liee.person; viaEntity = liee.entity; }
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
    // SELL first: "rachat d'actions" contains "achat" — check cession/vente before achat/acquisit
    if (lo.includes('cession') || lo.includes('vente') ||
        lo.includes('dispos')  || lo.includes('transfert') || lo.includes('rachat')) txType = 'SELL';
    else if (lo.includes('acquisit') || lo.includes('achat') ||
             lo.includes('souscri')  || lo.includes('exercice') ||
             lo.includes('attribut') || lo.includes('don') || lo.includes('héritage') ||
             lo.includes('remise')   || lo.includes('octroi')) txType = 'BUY';
  }

  // An "avenant réitératif" is a formal RENEWAL of a pre-existing multi-year
  // financing/hedging contract (share-acquisition facility, collar, pledge,
  // etc.) — not a fresh purchase decision. Its "PRIX UNITAIRE" is the
  // contract's ORIGINAL reference price from years earlier, carried forward
  // unchanged by the renewal (confirmed live: Ubisoft/Christian Guillemot,
  // 2026DD1116703 — "avenant réitératif au contrat d'acquisition d'actions
  // ... conclu le 1er septembre 2017", "Le prix de référence initial demeure
  // 56,8848 euros par action", the SAME 2017 figure just restated in 2026).
  // The word "acquisition" in that phrase would otherwise classify this BUY
  // like a real one, pairing a years-stale reference price with the current
  // date and producing a wildly wrong performance/return comparison. Nothing
  // is "wrong" about the extracted price — it's a real number from a real
  // filing — but it isn't a 2026 market transaction, so it's skipped rather
  // than saved as one.
  const isContractReiteration = /avenant\s+r[eé]it[eé]ratif/i.test(flat);

  // ── Price ─────────────────────────────────────────────────────────────────
  // Prefer PRIX UNITAIRE; fall back to PRIX in the aggregated section.
  // French numbers use a non-breaking space (U+00A0) or regular space as thousands
  // separator: "1 575.7679" — so [\d  .,]+ is required to capture the full value.
  // For multi-execution PDFs, prefer VWAP (prix moyen ponderé) over per-block unit price
  const priceRaw = grab([
    /prix\s+moyen\s+pond[eé]r[eé]\s*:\s*(\d[\d .,]+)/im,
    /PRIX UNITAIRE\s*:\s*(\d[\d  .,]+)/im,
    /PRIX D.EXERCICE\s*:\s*(\d[\d  .,]+)/im,
    /PRIX D.ATTRIBUTION\s*:\s*(\d[\d  .,]+)/im,
    /PRIX\s*:\s*(\d[\d  .,]+)/im,
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

  // ── ISIN / ticker ────────────────────────────────────────────────────────
  // Pattern: "CODE D'IDENTIFICATION DE L'INSTRUMENT FINANCIER : FR0010588079"
  // or:      "CODE D'IDENTIFICATION ... : FR0010169920 / ALPRE"
  // The apostrophe in the PDF is a curly/alternate Unicode char, so use D.IDENTIFICATION.
  let isin   = null;
  let ticker = null;
  const codeLine = flat.match(/CODE D.IDENTIFICATION[^\n]*/im)?.[0] || '';
  // ISIN body (after the 2-letter country prefix) is alphanumeric per the ISO 6166
  // spec, not digits-only — newer French ISINs use letters in it too (confirmed
  // live: ODYSSEE TECHNOLOGIES, FR001400U4P9). A digit-only requirement here
  // silently rejected these exactly like the missing-header-line issue below.
  const isinM    = codeLine.match(/:\s*([A-Z]{2}[A-Z0-9]{10})\b/);
  const tickerM  = codeLine.match(/\/\s*([A-Z][A-Z0-9]{1,7})\b/);  // exchange ticker after /
  // Every AMF filing carries the issuer's OWN equity ISIN on the document's own
  // header line, right below the doc reference number — "FR0000073272 - DD191759"
  // (confirmed live on SAFRAN, CARREFOUR, SOCIETE GENERALE, KERING, PUBLICIS
  // GROUPE — none of which have a "CODE D'IDENTIFICATION" line at all, a
  // different AMF filing template than the "CODE D'IDENTIFICATION ... : ISIN"
  // one this parser was originally built against). This header ISIN is checked
  // FIRST and wins over the "CODE D'IDENTIFICATION" line's ISIN, because that
  // line describes the TRANSACTED INSTRUMENT, which for employee savings-fund
  // trades ("Parts de fonds d'épargne salariale" / FCPE) is a fund-unit code
  // prefixed "QS" (AMF's internal quasi-security marker, not a real ISO 6166
  // country code) rather than the issuer's own share ISIN — confirmed live on
  // TOTALENERGIES SE, SANOFI, and GOLD BY GOLD, where trusting the code line
  // instead of the header silently attached an unresolvable fund-code "ISIN"
  // to what is really an ordinary insider trade in the issuer's own stock.
  const headerM = flat.match(/^([A-Z]{2}[A-Z0-9]{10})\s*-\s*DD\d+/m);
  if (headerM) {
    isin = headerM[1];
    // Only trust the code line's ticker suffix ("ISIN / TICKER") when its own
    // ISIN agrees with the header — otherwise it belongs to a different
    // instrument (the FCPE fund unit, not the issuer's equity) and must not be
    // attached here.
    if (isinM && isinM[1] === isin) ticker = tickerM ? tickerM[1] : null;
  } else if (isinM) {
    // No header ISIN at all (rare — confirmed live: some CANAL+ SA FCPE-only
    // filings ship a blank header, "- DDnnnnnn" with nothing before the dash).
    // Falling back to the code line's ISIN here is still better than nothing,
    // even though for FCPE trades it may itself be the QS-prefixed fund code
    // rather than the issuer's equity ISIN — isinToTicker() simply returns
    // null for those and the row is left tickerless rather than mismatched.
    isin   = isinM[1];
    ticker = tickerM ? tickerM[1] : null;
  }

  // For free share attributions (RSU/LTIP) the price is legitimately 0.
  // Detect this so price=0 (known nil grant) is stored instead of null (unknown).
  let parsedPrice = parseNum(priceRaw);
  if (parsedPrice == null) {
    const isNilGrant = /attribution\s+gratuite|actions\s+gratuites|prix\s+nul|prix\s*:\s*0|gratuit/i.test(flat);
    if (isNilGrant) parsedPrice = 0;
  }

  let parsedShares = parseNum(sharesRaw);

  // FCPE employee-savings-fund unit subscriptions (confirmed live: WENDEL's
  // "Relais Wendel 2026" fund, "Parts du FCPE ... d'une valeur unitaire de 10
  // euros") are a genuinely different instrument from equity shares: the
  // "VOLUME" is a fund-unit count that is LEGITIMATELY fractional (you can
  // hold 4 669.5920 units), and "PRIX UNITAIRE" is the fund's round par
  // value (10.0000), not a market share price. This is the exact same
  // fractional-VOLUME/whole-PRIX shape the swap heuristic below looks for,
  // but here it's correct as-is — swapping it inflates a EUR 10 fund-unit
  // subscription into a nonsense "EUR 4,669.59/share" trade. Must be
  // excluded from the swap check before it runs.
  const isFcpeFundUnit = /\bFCPE\b|parts?\s+(?:du|de|d')\s*fonds\s+(?:commun\s+de\s+placement|d.[eé]pargne)/i.test(flat);

  // Some filers transpose PRIX UNITAIRE and VOLUME entirely — confirmed live
  // on two unrelated companies (Unibail-Rodamco-Westfield / Rock Investment
  // SAS: "PRIX UNITAIRE: 5 000 000.0000" / "VOLUME: 103.4100", the filing's
  // OWN narrative confirming the real trade was 5,000,000 shares @ EUR
  // 103.41; Tikehau Capital / Tikehau Capital Advisors: "PRIX UNITAIRE:
  // 9 100.0000" / "VOLUME: 19.7500", where EUR ~19-20 matches Tikehau's real
  // share price and ~9,100 is a plausible share count). A share COUNT is
  // never genuinely fractional in a real disclosed trade — unlike a price,
  // which almost always carries cents — so a VOLUME value with a real
  // (non-floating-point-noise) fractional remainder, paired with a whole-
  // number PRIX UNITAIRE, reliably signals the two fields were swapped.
  // Confirmed this does NOT misfire on Hermès/Compagnie de l'Odet, both
  // genuinely >EUR 1,000/share but always with whole-number volumes.
  if (!isFcpeFundUnit &&
      parsedShares != null && parsedPrice != null &&
      Math.abs(parsedShares - Math.round(parsedShares)) > 0.001 &&
      Math.abs(parsedPrice - Math.round(parsedPrice)) < 0.001) {
    [parsedPrice, parsedShares] = [parsedShares, parsedPrice];
  }

  return {
    txType,
    insiderName: insiderName || null,
    viaEntity:   viaEntity   || null,
    role:        roleRaw     || null,
    shares:      parsedShares,
    price:       parsedPrice,
    ticker:      ticker      || null,
    isin:        isin        || null,
    isContractReiteration,
  };
}

async function scrapeFR() {
  console.log('🇫🇷  AMF France — BDIF Déclarations Dirigeants (MAR Article 19)');
  const t0   = Date.now();
  const co   = cutoff();
  const from = isoDate(co);
  const to   = isoDate(new Date());
  const fromApi = toApiDate(co);
  // AMF API treats DateFin as exclusive (< DateFin), so midnight-of-today misses
  // same-day filings. Use midnight of tomorrow to include today's filings.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const toApi   = toApiDate(tomorrow);
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
  const pdfDrops = { no_doc_path: 0, pdf_download_fail: 0, pdf_text_fail: 0, unknown_type: 0, missing_price: 0, missing_shares: 0, contract_reiteration: 0 };

  for (const r of allItems) {
    const numero  = r.numero || r.numeroConcatene || String(r.id || '');
    const txIso   = (r.dateInformation || r.datePublication || '').slice(0, 10) || from;
    const company = r.societes?.length > 0 ? r.societes[0].raisonSociale : null;
    const filingUrl = `https://bdif.amf-france.org/Registre-BDIF/Resultat-de-recherche?docId=${numero}`;

    // ── Get PDF path from list response (already included as r.documents[0]) ─
    const docPath = r.documents?.[0]?.path;
    if (!docPath) { nSkipped++; pdfDrops.no_doc_path++; continue; }

    await new Promise(res => setTimeout(res, 300)); // rate-limit AMF API

    // ── Download PDF ─────────────────────────────────────────────────────────
    const pdfBuf = await downloadPdf(docPath);
    if (!pdfBuf) { nSkipped++; pdfDrops.pdf_download_fail++; continue; }
    nPdf++;

    // ── Extract and parse text ───────────────────────────────────────────────
    const text   = pdfToText(pdfBuf);
    if (!text) { nSkipped++; pdfDrops.pdf_text_fail++; continue; }
    const parsed = parseFrPdf(text);

    if (parsed.txType === 'UNKNOWN') { nSkipped++; pdfDrops.unknown_type++; continue; }
    // Contract renewal, not a fresh purchase — its price is a years-old
    // reference figure, not a 2026 market price (see parseFrPdf comment).
    if (parsed.isContractReiteration) { nSkipped++; pdfDrops.contract_reiteration++; continue; }
    // Use ?? (not ||) so price=0 (confirmed free grant) is preserved as 0, not null.
    // || would coerce 0 to null, losing the information that this is a nil-price RSU.
    const price  = parsed.price  ?? null;
    if (!price)          pdfDrops.missing_price++;
    if (!parsed.shares)  pdfDrops.missing_shares++;
    nParsed++;

    const shares = parsed.shares ? Math.round(parsed.shares) : null;

    // Content-based ID: generated after PDF parse so type/shares/price are known
    const fid = contentId(COUNTRY_CODE, company, parsed.insiderName, parsed.txType, txIso, shares, price);
    if (seen.has(fid)) continue;
    seen.add(fid);

    // Ticker: exchange ticker from PDF > ISIN lookup; company-name fallback omitted
    // (European tickers rarely match company name — empty string is cleaner than a bad guess)
    const ticker = parsed.ticker
      || (parsed.isin ? await isinToTicker(parsed.isin, COUNTRY_CODE) : null)
      || '';

    dbRows.push({
      filing_id:        fid,
      country_code:     COUNTRY_CODE,
      ticker,
      company,
      insider_name:     parsed.insiderName || 'Not disclosed',
      via_entity:       parsed.viaEntity   || null,
      insider_role:     resolveFrRole(parsed.role) || null,
      transaction_type: parsed.txType,
      transaction_date: txIso,
      shares,
      price_per_share:  price,
      total_value:      (shares && price) ? Math.round(shares * price) : null,
      currency:         CURRENCY,
      filing_url:       filingUrl,
      source:           SOURCE,
      // Free RSU grants (price === 0) are not open-market purchases; flag them so
      // signals and performance tracking skip them automatically.
      is_unusual_price: price === 0 ? true : null,
    });
  }

  console.log(`  PDFs downloaded: ${nPdf} | Parsed BUY/SELL: ${nParsed} | Skipped: ${nSkipped}`);
  console.log(`  PDF drop reasons: no_path=${pdfDrops.no_doc_path} dl_fail=${pdfDrops.pdf_download_fail} text_fail=${pdfDrops.pdf_text_fail} unknown_type=${pdfDrops.unknown_type} contract_reiteration=${pdfDrops.contract_reiteration} | Of BUY/SELL: missing_price=${pdfDrops.missing_price} missing_shares=${pdfDrops.missing_shares}`);

  if (!dbRows.length) {
    console.log('  No BUY/SELL transactions found in PDFs.');
    return { saved: 0 };
  }

  // Preview
  for (const r of dbRows.slice(0, 3)) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares ?? 'n/a'} @ ${r.price_per_share ?? 'n/a'} | ${r.transaction_date}`);
  }

  const { error } = await saveInsiderTransactions(dbRows, { allowPartial: true });
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeFR().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
