/**
 * AT — Insider Transactions Scraper
 *
 * Source: OeKB (Oesterreichische Kontrollbank) — "OAM Issuer Info", Austria's
 * Officially Appointed Mechanism for MAR Art. 19 disclosures.
 *
 * API (undocumented, discovered via Puppeteer network inspection of
 * my.oekb.at/kapitalmarkt-services/kms-output/oamn/iic/list — confirmed public,
 * no authentication required):
 *
 *   1. List:  GET https://my.oekb.at/issuer-info/rest/public/meldedaten/iic
 *               ?spalte=uploadDatum&sortDirection=-1&status=VEROEFFENTLICHT
 *               &startPosition=<n>&offset=<n>&locale=DE
 *             -> { anzahlTreffer, dokumente: [{ id, emittent: {name, lei},
 *                  titel, meldetypCode, sprachcode, uploadzeitpunkt, isinBezug,
 *                  dateien: [{ id, dateiname, sprachcode }] }, ...] }
 *
 *   2. PDF:   GET https://my.oekb.at/issuer-info/rest/public/meldedaten/download/{fileId}
 *             fileId = dateien[0].id — NOT the document's own `id`.
 *
 * meldetypCode 'EP_EIGENGESCHAEFT_VON_FUEHRUNGSKRAFT' = Art. 19 MAR managers'
 * transactions. A `meldetypCode=` query param on the list endpoint is a
 * confirmed no-op (server ignores it, tested against EP_QUARTALBER) — filtered
 * client-side instead, same pattern used by every other scraper in this repo.
 *
 * Every Art. 19 filing is submitted in BOTH German and English as SEPARATE
 * document entries (different `id`, same emittent + near-identical upload
 * timestamp) — `sprachcode` marks which. Only the English entry is parsed, to
 * avoid double-counting the same transaction and because the field labels
 * below are English-only. (A German-only filing with no English counterpart
 * would be silently skipped — not observed in sampling, but a known gap.)
 *
 * PDFs are served natively (real text layer, no OCR needed) regardless of which
 * newswire — EQS or PTA/pressetext — originally distributed the announcement;
 * OeKB hosts the underlying document itself. Structurally close to Luxembourg's
 * EN-format form (same section numbering/labels — see scrapers/luxembourg.js),
 * but Austria's filings split into four sub-variants depending on whether the
 * discloser is the PDMR directly or a closely-associated entity trading on
 * their behalf (confirmed live across 10 real filings from 8 different issuers):
 *
 *   A. Direct person, single line:
 *        "a) Name    Marcus Frantz"
 *   B. Direct person, First/Last sub-fields (name too long / EQS template quirk):
 *        "a) Name" (blank) -> "First name:  Reinhard" / "Last name(s):  Lang"
 *   C. Closely-associated entity, First/Last sub-fields name the real person:
 *        "a) Name" (blank) -> "Name and legal form:  ENNOCONN CORPORATION"
 *        Section 2: "Person closely associated with:" -> "First name: Fu-Chuan" / "Last name(s): Chu"
 *   D. Closely-associated entity, prose name in section 2 (no First/Last fields):
 *        "a) Name    CPI IMMOHOLDCO B, a.s."
 *        Section 2: "Person is closely related to:" -> "Pavel Mechura, Management Board"
 *        (can list more than one person — only the first is captured)
 *
 * Price/volume: the "d) Aggregated price" field's semantics are inconsistent
 * across filers — some put a per-share price there (Kontron, Zumtobel, POLYTEC),
 * others put the total transaction value (Addiko: 7,215,000.00 for 195,000
 * shares at 37.00/share). Rather than disambiguate that field, shares and price
 * are derived directly from the individual "c) Price(s) / Volume(s)" execution
 * row(s) — reliably per-share in every sample — via a shares-weighted average,
 * sidestepping the ambiguity entirely.
 */
'use strict';

const https         = require('https');
const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { looksLikeCorp }           = require('./lib/entityUtils');
const { isinToTicker }            = require('./lib/isinToTicker');

const COUNTRY_CODE   = 'AT';
const SOURCE         = 'OeKB (OAM Issuer Info)';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
const MIN_PRICE_PER_SHARE = 0.01;

const BASE      = 'https://my.oekb.at/issuer-info/rest/public/meldedaten';
const ART19_CODE = 'EP_EIGENGESCHAEFT_VON_FUEHRUNGSKRAFT';
const PAGE_SIZE  = 50;
const HEADERS    = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function cutoff() { const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); return d; }

// ─── OeKB list API ────────────────────────────────────────────────────────────

async function fetchListPage(startPosition) {
  const url = `${BASE}/iic?spalte=uploadDatum&sortDirection=-1&status=VEROEFFENTLICHT` +
    `&startPosition=${startPosition}&offset=${PAGE_SIZE}&locale=DE`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res.json();
}

// Paginate newest-first until we cross the retention cutoff. Returns Art. 19,
// English-only entries within the window.
async function fetchListings(cutoffDate) {
  const rows = [];
  let startPosition = 0;
  while (true) {
    const data = await fetchListPage(startPosition);
    if (!data || !data.dokumente || !data.dokumente.length) break;

    for (const doc of data.dokumente) {
      if (doc.meldetypCode === ART19_CODE && doc.sprachcode === 'EN') rows.push(doc);
    }

    const oldest = new Date(data.dokumente[data.dokumente.length - 1].uploadzeitpunkt);
    if (oldest < cutoffDate) break;
    if (data.dokumente.length < PAGE_SIZE) break;

    startPosition += PAGE_SIZE;
    await new Promise(r => setTimeout(r, 300)); // be polite
  }
  return rows.filter(d => new Date(d.uploadzeitpunkt) >= cutoffDate);
}

// ─── PDF download + text extraction ──────────────────────────────────────────

function downloadPdf(fileId) {
  return new Promise((resolve) => {
    const req = https.get(`${BASE}/download/${fileId}`, { headers: HEADERS }, res => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

function pdfBufToText(buf) {
  const tmp = path.join('/tmp', `oekb-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    return execSync(`pdftotext -layout "${tmp}" -`, { encoding: 'utf8', timeout: 15000 });
  } catch { return null; }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// ─── PDF form parser ──────────────────────────────────────────────────────────

function parsePdf(text) {
  if (!text) return {};
  const lines = text.split('\n');

  // Value columns are typically 5+ spaces after the label keyword. Search only
  // the text AFTER the label match (not the whole line) so the label's own
  // leading indentation can't satisfy the gap regex first.
  function getField(labelRe, minSpaces, opts) {
    const sp = minSpaces || 5;
    const gapRe = new RegExp(`\\s{${sp},}(.+)$`);
    const loose = opts && opts.loose;
    for (let i = 0; i < lines.length; i++) {
      const labelMatch = lines[i].match(labelRe);
      if (!labelMatch) continue;
      const afterLabel = lines[i].slice(labelMatch.index + labelMatch[0].length);
      const m = afterLabel.match(gapRe);
      let val = m ? m[1].trim() : '';
      for (let j = i + 1; j < lines.length; j++) {
        const nl = lines[j];
        if (!nl.trim()) continue;
        if (/^\s{15,}/.test(nl) && !/^\s*[a-f]\)/.test(nl.trim())) { val += ' ' + nl.trim(); continue; }
        // Some filings (confirmed live: voestalpine, UNIQA, Kontron, AT&S — EQS-
        // sourced) leave the label line itself blank and print the value on the
        // very next line with only ~1 space of indentation, not the 15+ spaces
        // used elsewhere for wrapped-continuation text ("b) Nature of the
        // transaction" -> next line "Acquisition"; "e) Date of the transaction"
        // -> next line "2026-06-22; UTC+2"). Only accept this for callers that
        // opt in (`loose: true`) — applying it universally would risk swallowing
        // a genuinely blank sub-label like "Title:" as if it were section 1's
        // "a) Name" value, breaking the Variant B/C entity-vs-person detection
        // that depends on that field staying empty.
        if (loose && !val && !/^\s*[a-f]\)/.test(nl) && !/:\s*$/.test(nl.trim())) {
          val = nl.trim();
          continue;
        }
        break;
      }
      return val.trim() || null;
    }
    return null;
  }

  // ── Section 1/2: insider identity ───────────────────────────────────────────
  // Variant A/D: same-line value on "a) Name".
  let insiderName = getField(/^\s*a\)\s+Name\b/);
  let viaEntity   = null;

  // Variant C: entity named via a distinct "Name and legal form:" sub-field
  // (appears only when section 1's own "a) Name" line has no same-line value).
  const legalFormEntity = getField(/Name and legal form:?/i);
  if (legalFormEntity) {
    viaEntity    = legalFormEntity;
    insiderName  = null; // real person comes from First/Last fields in section 2
  } else if (insiderName && looksLikeCorp(insiderName)) {
    // Variant D: same-line value was itself a corporate entity, not a person.
    viaEntity   = insiderName;
    insiderName = null;
  }

  // Variant B/C: "First name:" / "Last name(s):" sub-fields hold the real person
  // — used both when there's no entity at all (B) and to name the person a
  // closely-associated entity is trading for (C).
  if (!insiderName) {
    const firstName = getField(/First name:?/i);
    const lastName  = getField(/Last name\(s\):?/i);
    if (firstName || lastName) insiderName = [firstName, lastName].filter(Boolean).join(' ').trim() || null;
  }

  // Variant D fallback: entity present but no First/Last fields — the real
  // person is named in prose after "Person is closely related to:" /
  // "Person closely associated with:", format "Name, Role" (possibly more than
  // one name; only the first is captured).
  let roleFromProse = null;
  if (!insiderName && viaEntity) {
    const markerIdx = lines.findIndex(l => /Person\s+(?:is\s+)?closely\s+(?:related|associated)/i.test(l));
    if (markerIdx >= 0) {
      for (let j = markerIdx; j < Math.min(markerIdx + 8, lines.length); j++) {
        const m = lines[j].match(/([A-ZÀ-ÖØ-Þ][\p{L}'-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'-]+)+)\s*,\s*(.+)$/u);
        if (m && !/^(?:Position|Title|Name)\b/i.test(m[1])) {
          insiderName  = m[1].trim();
          roleFromProse = m[2].trim();
          break;
        }
      }
    }
  }

  // ── Role ─────────────────────────────────────────────────────────────────
  // Variant A/B: direct "a) Position/status" value. For Variant D this line's
  // own value is the marker phrase itself ("Person is closely related to:"),
  // never a real role — ignore it in that case; the role for D was already
  // captured alongside the name above (m[2]).
  let role = getField(/^\s*a\)\s+Position\s*\/?\s*[Ss]tatus\b/);
  if (role && /closely\s+(?:related|associated)/i.test(role)) role = null;
  // Variant B/C: standalone "Position:" sub-field (appears after Title/First/Last).
  if (!role) role = getField(/^\s*Position:?\s*$/) || getField(/\bPosition:(?!\/)/) || roleFromProse;

  // ── Section 4: transaction(s) ────────────────────────────────────────────
  // Section 4 is explicitly repeatable per the form's own instructions
  // ("section to be repeated for (i) each type of instrument..."). Some
  // filers (confirmed live: CPI Europe AG, a filing closely-associated with
  // 3 separate IMMOFINANZ-linked derivative certificates) bundle several
  // distinct instrument transactions into one filing, each under its own
  // "Transaction No. N" marker with its own ISIN/nature/price/volume/date.
  // Parsing only the first occurrence of each field would silently misreport
  // transaction 2/3's data as if the whole filing were transaction 1's —
  // worse than dropping it, since it'd look complete. Split into blocks.
  const blockStarts = [];
  for (let i = 0; i < lines.length; i++) if (/^\s*Transaction No\.\s*\d+/i.test(lines[i])) blockStarts.push(i);
  const blocks = blockStarts.length
    ? blockStarts.map((start, idx) => lines.slice(start, blockStarts[idx + 1] ?? lines.length))
    : [lines]; // no repeated marker found — whole document is one block

  function parseBlock(blockLines) {
    function getBlockField(labelRe, minSpaces, opts) {
      // Reuses getField's logic against this block's own line slice.
      const sp = minSpaces || 5;
      const gapRe = new RegExp(`\\s{${sp},}(.+)$`);
      const loose = opts && opts.loose;
      for (let i = 0; i < blockLines.length; i++) {
        const labelMatch = blockLines[i].match(labelRe);
        if (!labelMatch) continue;
        const afterLabel = blockLines[i].slice(labelMatch.index + labelMatch[0].length);
        const m = afterLabel.match(gapRe);
        let val = m ? m[1].trim() : '';
        for (let j = i + 1; j < blockLines.length; j++) {
          const nl = blockLines[j];
          if (!nl.trim()) continue;
          if (/^\s{15,}/.test(nl) && !/^\s*[a-f]\)/.test(nl.trim())) { val += ' ' + nl.trim(); continue; }
          if (loose && !val && !/^\s*[a-f]\)/.test(nl) && !/:\s*$/.test(nl.trim())) { val = nl.trim(); continue; }
          break;
        }
        return val.trim() || null;
      }
      return null;
    }

    const natureTxt = getBlockField(/^\s*b\)\s+Nature of the transaction\b/i, null, { loose: true }) || '';
    let txType = 'UNKNOWN';
    const natLow = natureTxt.toLowerCase();
    if (/dispos|sale\b|sell/.test(natLow))                                    txType = 'SELL';
    else if (/acqui|purchas|subscri|exercise|award|grant|vest/.test(natLow))  txType = 'BUY';

    // Individual price/volume rows are reliably per-share across every sample
    // checked; the separate "Aggregated price" field's semantics vary (see
    // file header — some filers put a total there instead), so shares/price
    // are derived from these rows via a weighted average instead. Some filers
    // (EQS-sourced) print a section header "c) Price(s) and volume(s))"
    // followed on the NEXT line by the real table header "Price(s)  Volume(s)"
    // — others (PTA-sourced) combine both into one line with no "and
    // volume(s)" wording, and a few (CPI Europe) use bare "Price"/"Volume"
    // with no "(s)" suffix at all. Requiring whitespace-only adjacency (no
    // `.*` wildcard) matches the real table header in every case while
    // excluding the separate "...and volume(s)" section header, which would
    // otherwise be found first and make every row below it look non-matching.
    const priceHeaderIdx = blockLines.findIndex(l => /Price\(?s?\)?\s+Volume\(?s?\)?/i.test(l));
    let shares = null, pricePerShare = null, totalValue = null;
    if (priceHeaderIdx >= 0) {
      // Most filers use period-decimal / comma-thousands ("37.00 EUR" / "195,000
      // units"). At least one (confirmed live: BAWAG Group AG, via pressetext)
      // instead uses German convention throughout — comma-decimal / period-
      // thousands ("151,5 EUR" / "5.000 units") — which the default parsing
      // misreads catastrophically: "5.000"/"4.753" become 5 and 4.753 instead
      // of 5000 and 4753, corrupting `shares` into a fraction that Postgres's
      // bigint column then rejects outright, failing the ENTIRE batch insert
      // (not just this row). Detect German convention from a comma followed by
      // exactly 1-2 digits at the line's end — that shape is impossible as a
      // thousands remainder (always exactly 3 digits) so it unambiguously means
      // a decimal comma. Scanned once per block, not per row: a filer's number
      // convention doesn't change row-to-row within one filing.
      const tableSample = blockLines.slice(priceHeaderIdx, priceHeaderIdx + 10).join('\n');
      const isGerman = /\d,\d{1,2}\b/.test(tableSample);
      const parseNum = (raw) => isGerman
        ? parseFloat(raw.replace(/\./g, '').replace(',', '.'))
        : parseFloat(raw.replace(/,/g, ''));

      const rows = [];
      for (let j = priceHeaderIdx + 1; j < blockLines.length; j++) {
        const l = blockLines[j];
        if (!l.trim()) continue;
        if (/Aggregated|^\s*[de]\)/i.test(l)) break;
        // Volume's trailing unit label varies by filer: "Units", "Shares", or
        // "Shares/Units" (confirmed live: AUSTRIACARD HOLDINGS AG).
        const m = l.match(/^\s*([\d.,]+)\s*(?:EUR)?\s{2,}([\d.,]+)\s*(?:Shares\/Units|Shares|Units)?\s*$/i);
        if (!m) break;
        const price = parseNum(m[1]);
        const vol   = parseNum(m[2]);
        if (!isNaN(price) && !isNaN(vol) && vol > 0) rows.push({ price, vol });
      }
      if (rows.length) {
        const weightedTotal = rows.reduce((s, r) => s + r.price * r.vol, 0);
        // shares is a bigint column — a share count is never fractional by
        // definition, and one unrounded value here would fail the entire
        // batch insert (not just this row), as the isGerman detection above
        // was added to fix. Round defensively in case of any other
        // unforeseen number-format quirk from a filer not yet seen.
        shares = Math.round(rows.reduce((s, r) => s + r.vol, 0));
        pricePerShare = shares > 0 ? parseFloat((weightedTotal / shares).toFixed(6)) : null;
        totalValue    = Math.round(weightedTotal);
      }
    }
    if (pricePerShare != null && pricePerShare < MIN_PRICE_PER_SHARE) { pricePerShare = null; totalValue = null; }

    const dateTxt = getBlockField(/^\s*e\)\s+Date of the transaction\b/i, null, { loose: true }) || '';
    let txDate = null;
    const dIso = dateTxt.match(/(\d{4}-\d{2}-\d{2})/);
    if (dIso) txDate = dIso[1];
    else {
      const dDmy = dateTxt.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (dDmy) txDate = `${dDmy[3]}-${dDmy[2].padStart(2,'0')}-${dDmy[1].padStart(2,'0')}`;
    }

    let isin = null;
    const isinM = blockLines.join('\n').match(/\bISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})\b/);
    if (isinM) isin = isinM[1];

    return { isin, txType, shares, pricePerShare, totalValue, txDate };
  }

  const transactions = blocks.map(parseBlock);

  return { insiderName, viaEntity, role, transactions };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeAT() {
  console.log('🇦🇹  OeKB — OAM Issuer Info (Art. 19 MAR)');
  const t0 = Date.now();
  const co = cutoff();
  console.log(`  Fetching entries since ${isoDate(co)}…`);

  const listings = await fetchListings(co);
  console.log(`  Found ${listings.length} Article 19 (EN) filings`);
  if (!listings.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const dbRows = [];
  const seen = new Set();

  for (const doc of listings) {
    const fid = `AT-OeKB-${doc.id}`;
    if (seen.has(fid)) continue;
    seen.add(fid);

    const fileId = doc.dateien && doc.dateien[0] && doc.dateien[0].id;
    if (!fileId) {
      console.log(`  ⚠  ${doc.id} (${doc.emittent?.name}) — no attached file`);
      continue;
    }

    const buf = await downloadPdf(fileId);
    if (!buf) {
      console.log(`  ⚠  ${doc.id} (${doc.emittent?.name}) — PDF download failed`);
      continue;
    }

    const text = pdfBufToText(buf);
    const f = parsePdf(text);

    if (!f.insiderName && !f.viaEntity) {
      console.log(`  ⚠  ${doc.id} (${doc.emittent?.name}) — insider name not found in PDF; row will be dropped`);
    }

    const pdfUrl = `${BASE}/download/${fileId}`;
    // OeKB's own isinBezug metadata is sometimes malformed — confirmed live
    // (Zumtobel Group AG, ref 250521): "AT0000837307 (Aktie)," instead of a bare
    // ISIN. Extract just the 12-char ISIN shape rather than trusting the raw field.
    const rawIsinBezug = (doc.isinBezug && doc.isinBezug[0]) || '';
    const isinBezugM   = rawIsinBezug.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
    const defaultIsin  = isinBezugM ? isinBezugM[1] : '';
    const txns = f.transactions && f.transactions.length ? f.transactions : [{}];

    // A single filing can bundle multiple distinct instrument transactions (see
    // parsePdf) — one row per block, sharing the same insider/company/filing_url.
    // Suffix filing_id with the block index (beyond the first) so each gets its
    // own DB row on upsert, matching the convention used in scrapers/luxembourg.js.
    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      const rowFid = i === 0 ? fid : `${fid}-${i + 1}`;
      const isin = tx.isin || defaultIsin;
      const ticker = isin ? (await isinToTicker(isin, COUNTRY_CODE) || isin) : '';
      const txDate = tx.txDate || isoDate(new Date(doc.uploadzeitpunkt));

      process.stdout.write(`  → ${doc.id}${i > 0 ? `.${i + 1}` : ''} ${(doc.emittent?.name || '?').slice(0, 28).padEnd(28)} ${(tx.txType||'UNKNOWN').padEnd(4)} ${tx.shares ?? '?'} @ ${tx.pricePerShare ?? '?'} EUR  ${txDate}\n`);

      dbRows.push({
        filing_id:        rowFid,
        country_code:     COUNTRY_CODE,
        ticker,
        company:          doc.emittent?.name || null,
        insider_name:     f.insiderName || null,
        via_entity:       f.viaEntity || null,
        insider_role:     translateRole(f.role) || null,
        transaction_type: tx.txType || 'UNKNOWN',
        transaction_date: txDate,
        shares:           tx.shares,
        price_per_share:  tx.pricePerShare,
        total_value:      tx.totalValue,
        currency:         CURRENCY,
        filing_url:       pdfUrl,
        source:           SOURCE,
      });
    }

    await new Promise(r => setTimeout(r, 200)); // be polite to OeKB
  }

  if (!dbRows.length) { console.log('  Nothing to save.'); return { saved: 0 }; }

  const { error } = await saveInsiderTransactions(dbRows);
  if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
  const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
  console.log(`  ✅ ${elapsed}s — ${dbRows.length} rows processed (${buys} BUY, ${sells} SELL)`);
  return { saved: dbRows.length };
}

scrapeAT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
