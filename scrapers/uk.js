/**
 * UK — Insider Transactions Scraper
 *
 * Source: FCA National Storage Mechanism (NSM)
 * Search API: POST https://api.data.fca.org.uk/search?index=nsm-search
 * Details API: GET  https://api.data.fca.org.uk/details/{id}?index=nsm-search
 *
 * Note: FCA renamed the index from "fca-nsm-searchdata" to "nsm-search" at some
 * point before 2026-07-14 (confirmed via the live nsm_index_name value in FCA's
 * own frontend bundle at data.fca.org.uk/main.js) — the old name now 400s with
 * "Invalid index" on /search and 502s on /details. Both this scraper and
 * buybacks/uk-buybacks.js were silently broken for ~9-10 days as a result
 * (masked by `continue-on-error: true` in the GitHub Actions workflows).
 *
 * Type filter: "Director/PDMR Shareholding"
 * /details no longer returns document_content (dropped by FCA, see note above)
 * — the MAR Art. 19 form text is fetched from the artefact HTML at
 * data.fca.org.uk/artefacts/{download_link} and flattened via lib/htmlToText.
 *
 * No authentication required — search and details endpoints are public.
 */
'use strict';

const https = require('https');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { looksLikeCorp }           = require('./lib/entityUtils');
const { isinToTicker }            = require('./lib/isinToTicker');
const { isAbsoluteUnusualPrice }  = require('./lib/unusualPrice');
const { htmlToText }              = require('./lib/htmlToText');

const COUNTRY_CODE    = 'GB';
const SOURCE          = 'FCA NSM / RNS';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CONCURRENCY     = 3;
const REQUEST_DELAY_MS = 150;  // Avoid rate-limiting the FCA NSM API

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postJson(path, body) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.data.fca.org.uk',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Origin': 'https://data.fca.org.uk',
        'Referer': 'https://data.fca.org.uk/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// FCA dropped _source.document_content from /details (see note above) — the
// actual form text now only lives in this artefact HTML page.
function fetchArtefactHtml(downloadLink) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'data.fca.org.uk',
      path: `/artefacts/${downloadLink}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

function fetchDetails(id) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.data.fca.org.uk',
      path: `/details/${encodeURIComponent(id)}?index=nsm-search`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://data.fca.org.uk',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function grabAfter(text, ...patterns) {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

// Parse price string like "21p", "21.5p", "125p", "£2.50", "GBp 150", "GBX 150", "200 pence"
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const s = priceStr.trim();
  // pence: "21p", "21.5p"
  let m = s.match(/^([\d,\.]+)p$/i);
  if (m) return parseFloat(m[1].replace(/,/g, '')) / 100;  // convert pence to GBP
  // GBp or GBX (pence): "GBp 21.5" or "GBX 21.5"
  m = s.match(/(?:GBp|GBX|GBX)\s+([\d,\.]+)/i);
  if (m) return parseFloat(m[1].replace(/,/g, '')) / 100;
  // Sterling: "£21.50" or "GBP 21.50"
  m = s.match(/(?:£|GBP)\s*([\d,\.]+)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  // "200 pence"
  m = s.match(/([\d,\.]+)\s+pence/i);
  if (m) return parseFloat(m[1].replace(/,/g, '')) / 100;
  // Other currencies with or without space: CNY38.957, USD 12.50, HKD 5.00
  m = s.match(/^[A-Z]{2,3}\s*([\d,\.]+)/);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  // Raw number
  m = s.match(/^([\d,\.]+)$/);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return null;
}

// Parse volume string like "26,000" or "26000" or "26 000"
function parseVolume(volStr) {
  if (!volStr) return null;
  // Take only the first contiguous digit run (ignore anything that follows whitespace)
  const firstRun = volStr.trim().match(/^[\d,]+/);
  if (!firstRun) return null;
  const clean = firstRun[0].replace(/,/g, '');
  const n = parseInt(clean, 10);
  // Sanity: reject implausibly large values (> 1 billion shares)
  if (isNaN(n) || n <= 0 || n > 1_000_000_000) return null;
  return n;
}

// Parse date like "10 April 2026" or "10-Apr-2026" or "2026-04-10"
function parseDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "10 April 2026"
  const months = { january:1, february:2, march:3, april:4, may:5, june:6,
                   july:7, august:8, september:9, october:10, november:11, december:12,
                   jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  let m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const month = months[m[2].toLowerCase()];
    if (month) return `${m[3]}-${String(month).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  }
  return null;
}

function mapType(natureText) {
  if (!natureText) return 'OTHER';
  const l = natureText.toLowerCase();
  // Check SELL first — "Sale of shares...Share Buyback Programme" contains "buy" via "buyback"
  if (l.includes('sale') || l.includes('sell') || l.includes('dispos')) return 'SELL';
  // \bbuy\b avoids matching "buyback" — but buyback itself is a company repurchase, not insider buy
  if (l.includes('purchase') || l.includes('acqui') || l.includes('subscri') ||
      l.includes('vest') || l.includes('exercise') || l.includes('receipt') ||
      /\bbuy\b/.test(l)) return 'BUY';
  return 'OTHER';
}

/**
 * Parse the flat text document_content string from the FCA NSM details response.
 * The content follows the MAR Art. 19 PDMR notification form structure.
 * Returns array of parsed transactions (usually 1, sometimes multiple PDMRs).
 */
function parseDocumentContent(content, meta) {
  if (!content) return [];

  // Normalise whitespace
  const t = content.replace(/\s+/g, ' ').trim();

  // Extract section 1: person name(s)
  // "1 Details of the person discharging managerial responsibilities ... a) Name <name> 2 Reason"
  const nameSecRaw = grabAfter(t,
    /\ba\)\s*Name\s+([\s\S]+?)\s+2\.?\s+Reasons?\b/i,  // handles "2. Reason" (with period) and "2. Reasons" (plural)
    /\ba\)\s*Name\s+([\s\S]+?)\s+b\)\s*(?:Reason|LEI|Position|Status)/i,
    /\ba\)\s*Name\s+([^\n]{2,80})/,
  );
  // Guard: if extraction ran past section boundary the raw string will be very long.
  // Cap at 120 chars; if over that, keep only the first non-empty line.
  const nameSec = nameSecRaw && nameSecRaw.length > 120
    ? (nameSecRaw.split('\n').map(l => l.trim()).find(l => l.length > 1 && l.length <= 80) || null)
    : nameSecRaw;

  // Extract section 2: position
  const posSec = grabAfter(t,
    /\ba\)\s*Position\s*(?:\/\s*status|status)\s+([\s\S]+?)\s+b\)\s*Initial/i,
    /\ba\)\s*Position\s*(?:\/\s*status|status)\s+([\s\S]+?)\s+(?:b\)|3\s+Details)/i
  );

  // Extract section 3: issuer name
  const issuerSec = grabAfter(t,
    /3\s+Details\s+of\s+the\s+issuer[\s\S]+?a\)\s*Name\s+([\s\S]+?)\s+b\)\s*LEI/i
  );

  // Extract section 4: transaction details
  // ISIN: standard 12-char code GB + 10 alphanumeric
  const isinMatch = t.match(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/);
  const isin = isinMatch ? isinMatch[1] : null;

  // Nature of transaction
  const nature = grabAfter(t,
    /\bb\)\s*Nature\s+of\s+the\s+transaction\s+([\s\S]+?)\s+c\)\s*Price/i,
    /\bb\)\s*Nature\s+of\s+the\s+transaction\s+([\s\S]+?)\s+(?:d\)|e\)|f\))/i
  );

  // Price and volume from section c)
  // Formats vary:
  //   "c)   Price(s) and volume(s)   Price(s) 56.22 pence       Volume(s) 35,000       d)"
  //   "c)   Price(s) and volume(s) Price(s) Volume(s) 21p 26,000 d)"
  //   "c)   Price(s) and volume(s) Price(s) Volume(s) CNY38.957 12800 d)"
  const priceVolBlock = t.match(/\bc\)\s*Price\(s\)\s*and\s*volume\(s\)([\s\S]+?)\bd\)/i)?.[1] || '';

  // Date of transaction
  const transDateStr = grabAfter(t,
    /\be\)\s*Date\s+of\s+the\s+transaction\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i,
    /\be\)\s*Date\s+of\s+the\s+transaction\s+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i
  );

  let price = null, volume = null;
  if (priceVolBlock) {
    // Word-bounded: an unbounded "N A" match corrupts ordinary words containing
    // "na" case-insensitively (e.g. "Ordinary" → "Ordi0ry"), silently breaking
    // any downstream pattern that expects that literal text.
    const pvStr = priceVolBlock.replace(/\bN\s*\/?\s*A\b|\bnil\b/gi, '0').trim();

    // Pattern A-dual: "Nil cost 0.03p 548,055 258,105" — a combined option-exercise
    // + sale-to-cover-tax notification. Two price columns (nil-cost, priced) each
    // pair positionally with their own volume column: nil↔vol1 (exercise), price↔vol2
    // (sale). Must pair the priced column with the SECOND volume, not the first —
    // otherwise you get the priced sale's price attached to the exercise's much
    // larger share count (e.g. price 0.03p × 548,055 exercised shares instead of the
    // 258,105 actually sold at that price).
    // Unit suffix on the price group is mandatory (not "?") — otherwise a bare
    // number belonging to a THIRD nil-cost tranche (e.g. "0 consideration 0
    // consideration 0 consideration 79,653 56,786 4,829" — three grant tranches,
    // no priced sale at all) gets misread as the "price".
    const dualM = pvStr.match(/\b0\b\s*(?:[a-z]+\s+)?([\d,\.]+\s*(?:p\b|pence\b|GBp\b|GBX\b|GBP\b|£))\s+([\d,]+)\s+([\d,]+)\s*$/i);
    if (dualM) {
      price = parsePrice(dualM[1].trim());
      volume = parseVolume(dualM[3].trim());
    }

    // Pattern A-dual2: "Nil <vol1> ... <price>p <vol2>" — same nil-cost-vesting +
    // priced-tax-sale shape as above but with the two sub-items spread across a
    // longer narrative line instead of clustered together, e.g. "Acquisition of
    // shares on vesting of award Nil 841,045 Sale of shares to satisfy income tax
    // and NIC liability 77.792p 396,282". Without this, the "derive price from
    // aggregate consideration" fallback below misreads the pence-suffixed sale
    // price as a GBP total and divides it by the unrelated nil-cost volume,
    // producing a price ~1000x too small (e.g. £0.000092 instead of £0.778).
    if (price === null && volume === null && /\bnil\b|\bn\s*\/?\s*a\b/i.test(priceVolBlock)) {
      const dual2M = pvStr.match(/([\d,\.]+)\s*p\b\s+([\d,]+)\s*$/i);
      if (dual2M) {
        price = parsePrice(dual2M[1].trim() + 'p');
        volume = parseVolume(dual2M[2].trim());
      }
    }

    // Pattern A: "Price(s) <price> Volume(s) <volume>" — table with labels
    if (!price && !volume) {
      const labelM = pvStr.match(/Price\(s\)\s+([\S]+(?:\s+\S+)?)\s+Volume\(s\)\s+([\d,\s]+)/i);
      if (labelM) {
        price = parsePrice(labelM[1].trim());
        volume = parseVolume(labelM[2].trim());
      }
    }

    if (!price && !volume) {
      // Pattern B: "<price_with_currency> <volume>" — "21p 26,000" or "GBP 1.50 5000" or "CNY38.957 12800"
      const pvMatch = pvStr.match(/([A-Z]{0,3}[£$€]?[\d,\.]+\s*(?:p\b|pence\b|GBp\b|GBX\b|GBP\b|EUR\b|USD\b|CNY\b|SEK\b|NOK\b|CHF\b)?)\s+([\d,\s]{2,})/i);
      if (pvMatch) {
        price = parsePrice(pvMatch[1].trim());
        volume = parseVolume(pvMatch[2].trim());
      }
    }

    if (!price && !volume) {
      // Pattern C: "<N> Ordinary Shares at £<price>" — narrative purchase/sale
      // format, e.g. "Purchase: 2,880 Ordinary Shares at £3.43500 Sale: 400
      // Ordinary Shares at £3.40451". Takes the first share block only —
      // combined PDMR + PCA disclosures with two different people dealing
      // aren't split into separate rows by this parser. Without this pattern
      // the block falls through to the "Aggregated information ... £X" fallback
      // below, which misreads this same per-share price as a total consideration
      // and divides it by the share count again (£3.435 / 2,880 = £0.0012/share).
      const atM = pvStr.match(/([\d,]+)\s+(?:Ordinary\s+)?Shares?\s+at\s+(?:£|GBP\s*)?([\d,\.]+)/i);
      if (atM) {
        volume = parseVolume(atM[1].trim());
        price = parseFloat(atM[2].replace(/,/g, ''));
      }
    }

    if (!volume) {
      // Last resort: find any reasonably large number as volume
      const volM = pvStr.match(/Volume\(s\)\s+([\d,\s]+)/i) || pvStr.match(/\b([\d,]{3,})\b/);
      if (volM) volume = parseVolume(volM[1]);
    }
  }

  // ── Total consideration → derive price when price still null ──────────────
  // Try "f) Aggregate consideration £45,678" or "Total consideration paid: GBp 12,345"
  const totalConsidGBP = (() => {
    const patterns = [
      /\bf\)\s*Aggregate\s+consideration\s+(?:£|GBP\s*)?([\d,\.]+)/i,
      /aggregate\s+consideration\s*[:\s]+(?:£|GBP\s*)?([\d,\.]+)/i,
      /total\s+consideration\s+(?:paid\s+)?[:\s]+(?:£|GBP\s*)?([\d,\.]+)/i,
      /consideration\s+of\s+(?:£|GBP\s*)?([\d,\.]+)/i,
      // "d) Aggregated information ... £45,678" (section d variant)
      /\bd\)\s*Aggregated\s+information[\s\S]{0,200}?(?:£|GBP\s*)([\d,\.]+)/i,
    ];
    for (const pat of patterns) {
      const m = t.match(pat);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(n) && n > 0) return n;
      }
    }
    // GBp / pence aggregates: "Aggregate consideration 123,456 GBp" or "123,456p"
    const pencePatterns = [
      /aggregate\s+consideration\s+([\d,\.]+)\s*GBp/i,
      /aggregate\s+consideration\s+([\d,\.]+)\s*pence/i,
      /\bf\)\s*Aggregate\s+consideration\s+([\d,\.]+)\s*(?:GBp|pence|p\b)/i,
    ];
    for (const pp of pencePatterns) {
      const pm = t.match(pp);
      if (pm) {
        const n = parseFloat(pm[1].replace(/,/g, ''));
        if (!isNaN(n) && n > 0) return n / 100; // pence → GBP
      }
    }
    return null;
  })();

  if (!price && volume && totalConsidGBP) {
    const derived = parseFloat((totalConsidGBP / volume).toFixed(6));
    // Sanity cap: no UK-listed stock trades above £500/share.
    // If the derived price exceeds this, the aggregate consideration was likely
    // captured in the wrong units (pence misread as GBP, or wrong field).
    // Null price → row dropped rather than saved with garbage data.
    if (derived <= 500) {
      price = derived;
    } else {
      console.warn(`  UK price sanity: derived £${derived}/share from agg ${totalConsidGBP} / ${volume} shares — too high, dropping price`);
    }
  }

  // ── Inline price in nature text ───────────────────────────────────────────
  // "Purchase at 250p per share" or "acquired at a price of 125p"
  if (!price && nature) {
    const inlineM = nature.match(/at\s+(?:a\s+price\s+of\s+)?([\d,\.]+\s*(?:p\b|pence\b|GBp\b|GBX\b|GBP\b|£))/i);
    if (inlineM) price = parsePrice(inlineM[1]);
  }

  // ── Explicitly N/A price → 0 (LTIP / free share award) ───────────────────
  // When the priceVolBlock says "N/A" or "nil" for price but volume is valid → price = 0
  if (price === null && volume && priceVolBlock &&
      /N\/A|nil|no\s+consideration|free\s+(?:of\s+)?charge|waived|no\s+cost/i.test(priceVolBlock)) {
    price = 0;
  }

  const transDate = parseDate(transDateStr);
  const txType = mapType(nature || '');

  // Handle multiple PDMRs in one document
  // Names might be "1. Katie Worgan 2. Emma Holden" or "Katie Worgan"
  const names = [];
  const positions = [];

  // Strip leaked MAR form section text from a captured name string.
  // Handles: "Toby Courtauld 2. Reason for the notification…" → "Toby Courtauld"
  //          "June Aitken 2. Reasons for the notification…"   → "June Aitken"
  //          "Mark Cubitt a) Position status…"                → "Mark Cubitt"
  const stripFormSections = s => !s ? s : s
    .replace(/\s*\d+\.?\s+Reasons?\s+for\b.*/si, '')
    .replace(/\s*\d+\.?\s+(?:Position|Nature|Details|Notification)\b.*/si, '')
    .replace(/\s+[a-d]\)\s+(?:Position|Reason|Nature|LEI|Legal\s+Entity)\b.*/si, '')
    .trim();

  if (nameSec) {
    // Check for numbered list pattern "1. Name 2. Name"
    const numbered = nameSec.match(/\d+\.\s*([^\d\.]+)/g);
    if (numbered && numbered.length > 1) {
      for (const n of numbered) {
        const nm = stripFormSections(n.replace(/^\d+\.\s*/, '').trim());
        if (nm) names.push(nm);
      }
    } else {
      names.push(stripFormSections(nameSec.replace(/^\d+\.\s*/, '').trim()));
    }
  }

  if (posSec) {
    const numbered = posSec.match(/\d+\.\s*([^\d\.]+)/g);
    if (numbered && numbered.length > 1) {
      for (const p of numbered) {
        const pos = p.replace(/^\d+\.\s*/, '').trim()
                     .replace(/\s*PDMR\s*$/i, '').trim();
        if (pos) positions.push(pos);
      }
    } else {
      positions.push(posSec.replace(/^\d+\.\s*/, '').trim()
                           .replace(/\s*PDMR\s*$/i, '').trim());
    }
  }

  if (names.length === 0) {
    // Last resort: try extracting name from the preamble text
    const preamble = t.slice(0, 600);
    const m = preamble.match(/(?:announces?\s+that\s+on\s+\S+\s+\S+\s+\d{4},?\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}),\s+([A-Za-z\s]+(?:Officer|Director|Executive|Chairman|President|Manager|Head)[^,]*)/i);
    if (m) {
      names.push(m[1]);
      if (!positions.length) positions.push(m[2].trim());
    }
  }

  if (names.length === 0) return [];  // Cannot determine insider name

  // For each name: if it looks like a corporate entity, try to extract the associated person.
  // Two patterns found in UK RNS filings:
  //   1. "Entity closely associated with PERSON PDMR" — PERSON in the position/status section
  //   2. "Entity is a PCA of PERSON, role" — PCA (Person Closely Associated) in the name itself
  const viaEntities = new Array(names.length).fill(null);
  for (let i = 0; i < names.length; i++) {
    // Pattern 2: "Entity is a PCA of PersonName" embedded in the extracted name string
    const pcaM = names[i]?.match(/^(.+?)\s+is\s+a\s+PCA\s+of\s+([A-Z][a-zA-Z\s\-\.]{2,60}?)(?:,\s.*)?$/i);
    if (pcaM && looksLikeCorp(pcaM[1].trim())) {
      viaEntities[i] = pcaM[1].trim();
      names[i]       = pcaM[2].trim();
      continue;
    }
    if (looksLikeCorp(names[i])) {
      // Pattern 1: person named in the position/status section
      const posText = positions[i] || positions[0] || posSec || '';
      const assocM = posText.match(/closely\s+associated\s+with\s+([A-Z][a-zA-Z\s\-\.]{2,50}?)(?:\s+PDMR|\s*$)/i);
      if (assocM) {
        viaEntities[i] = names[i];
        names[i] = assocM[1].trim();
      }
    }
  }

  const company = issuerSec || meta.company || null;

  // Fall back to filing submission date if transaction date couldn't be parsed
  const effectiveDate = transDate || meta.submitted_date?.slice(0, 10) || null;
  if (!effectiveDate) return [];  // Cannot determine date — skip row

  // Generate one row per PDMR (usually just one)
  return names.map((name, i) => ({
    filing_id:        names.length > 1 ? `${meta.id}-${i}` : meta.id,
    country_code:     COUNTRY_CODE,
    source:           SOURCE,
    ticker:           isin || '',
    company:          company || null,
    insider_name:     name,
    via_entity:       viaEntities[i] || null,
    insider_role:     translateRole(positions[i] || positions[0] || null),
    transaction_type: txType,
    transaction_date: effectiveDate,
    price_per_share:  price,
    currency:         'GBP',
    shares:           volume,
    total_value:      (price && volume) ? Math.round(price * volume) : null,
    filing_url:       meta.download_link ? `https://data.fca.org.uk/${meta.download_link}` : null,
    // Not in the original task list but the same gap applies here: a nil-cost or
    // sub-unit price is a vesting/option event, not a market price.
    is_unusual_price: isAbsoluteUnusualPrice(price) ? true : null,
  }));
}

// ---------------------------------------------------------------------------
// Batch / concurrency helpers
// ---------------------------------------------------------------------------

async function runBatch(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      results.push(await fn(item));
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results.flat();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeUK() {
  console.log('🇬🇧  FCA NSM — PDMR Director/Shareholding transactions');
  const t0 = Date.now();
  const today = new Date();
  const cutoffDate = new Date(today.getTime() - RETENTION_DAYS * 86400000);

  const fromStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const toStr   = today.toISOString().replace(/\.\d{3}Z$/, 'Z');
  console.log(`  Range: ${fromStr} → ${toStr}`);

  // Search for all PDMR disclosures in the date range
  let allHits = [];
  const pageSize = 100;
  let from = 0;
  let total = null;

  while (true) {
    const res = await postJson('/search?index=nsm-search', {
      from,
      size: pageSize,
      sort: 'submitted_date',
      sortorder: 'desc',
      criteriaObj: {
        criteria: [{ name: 'headline', value: 'PDMR' }],
        dateCriteria: [{
          name: 'submitted_date',
          value: { from: fromStr, to: toStr }
        }]
      }
    });

    if (!res || !res.hits) {
      if (res?.message) console.error(`  Search API error: ${res.message}`);
      else console.error('  Search API no response (rate-limited or network error)');
      break;
    }

    const hits = res.hits.hits || [];
    if (total === null) total = res.hits.total?.value || 0;

    if (hits.length === 0) break;
    allHits = allHits.concat(hits);
    from += hits.length;

    if (from >= total) break;
  }

  console.log(`  Found ${total} total hits, processing ${allHits.length}`);

  if (allHits.length === 0) {
    console.log('  No results — exiting');
    return;
  }

  // Fetch details for each document and parse
  let rows = [];
  let fetched = 0, parsed = 0, failed = 0;

  const processHit = async (hit) => {
    const meta = {
      id: hit._id,
      company: hit._source?.company,
      submitted_date: hit._source?.submitted_date,
      download_link: hit._source?.download_link,
    };

    // Check if document_content already in search result
    let content = hit._source?.document_content;

    if (!content) {
      // Fetch details (rate-limit: small delay between requests)
      await delay(REQUEST_DELAY_MS);
      const details = await fetchDetails(hit._id);
      if (!details?._source) { failed++; return []; }
      content = details._source.document_content;
      meta.company = meta.company || details._source.company;
      meta.download_link = meta.download_link || details._source.download_link;
    }

    // FCA no longer returns document_content from /details at all (see note at
    // top of file) — fall back to fetching the artefact HTML directly and
    // flattening it to the same plain-text shape parseDocumentContent expects.
    if (!content && meta.download_link) {
      await delay(REQUEST_DELAY_MS);
      const html = await fetchArtefactHtml(meta.download_link);
      if (html) content = htmlToText(html);
    }

    fetched++;
    const parsed_rows = parseDocumentContent(content, meta);
    if (parsed_rows.length > 0) parsed++;
    return parsed_rows;
  };

  // Filter to only Director/PDMR Shareholding type (search by headline may include others)
  const pdmrHits = allHits.filter(h =>
    (h._source?.type || '').includes('PDMR') ||
    (h._source?.headline || '').includes('PDMR') ||
    (h._source?.type || '').includes('Director')
  );

  console.log(`  Processing ${pdmrHits.length} PDMR-type documents (CONCURRENCY=${CONCURRENCY})…`);

  rows = await runBatch(pdmrHits, CONCURRENCY, processHit);

  // Resolve ISIN-format tickers to real exchange symbols
  const isISIN = t => /^[A-Z]{2}[A-Z0-9]{10}$/.test(t);
  for (const row of rows) {
    if (row.ticker && isISIN(row.ticker)) {
      row.ticker = await isinToTicker(row.ticker, COUNTRY_CODE) || row.ticker;
    }
  }

  // Deduplicate cross-document: FCA sometimes has 2 filings for the same transaction
  // (company filing + individual filing). Keep the first occurrence per unique tuple.
  const seen = new Set();
  rows = rows.filter(r => {
    const key = `${r.insider_name}|${r.company}|${r.transaction_date}|${r.shares}|${r.price_per_share}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Secondary dedup: multiple PDMRs filing for the same underlying block of shares
  // (e.g. a rights issue where several directors notify the same transaction).
  // When company + date + shares + price all match exactly, keep only the first person.
  const seenTx = new Set();
  rows = rows.filter(r => {
    const txKey = `${r.company}|${r.transaction_date}|${r.shares}|${r.price_per_share}`;
    if (seenTx.has(txKey)) return false;
    seenTx.add(txKey);
    return true;
  });

  console.log(`  Fetched: ${fetched} | Parsed: ${parsed} | Failed: ${failed}`);
  console.log(`  Rows extracted: ${rows.length}`);

  if (rows.length === 0) {
    console.log('  No rows to save');
    return;
  }

  // Preview
  const sample = rows.slice(0, 3);
  for (const r of sample) {
    console.log(`  • ${r.company} | ${r.insider_name} | ${r.transaction_type} | ${r.shares} @ ${r.price_per_share} GBP | ${r.transaction_date}`);
  }

  const { inserted, error } = await saveInsiderTransactions(rows, { allowPartial: true });
  if (error) {
    console.error('  ❌ DB error:', error.message);
  } else {
    console.log(`  ✅ Saved ${inserted} rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  }
}

scrapeUK().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
