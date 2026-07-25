/**
 * PT — Insider Transactions Scraper
 *
 * Source: CMVM (Comissão do Mercado de Valores Mobiliários) Portugal
 * Portal: https://www.cmvm.pt/PInstitucional/ → SDI → Emitentes → Transações de dirigentes
 *
 * Strategy:
 *   1. Use Puppeteer to navigate CMVM's OutSystems portal to the
 *      "Transações de dirigentes" (Management Transactions) section.
 *   2. Intercept the DataActionGetReports API response, which returns a list
 *      of TRAN PDF notifications with metadata (company, date, encryptedURL).
 *   3. For each recent TRAN notification, navigate to its EncryptedURL to obtain
 *      the base64-encoded PDF via DataActionFetchDecriptInput.
 *   4. Decode the PDF and extract structured fields using pdftotext (poppler-utils).
 *   5. Save to Supabase.
 *
 * PDF fields extracted (ESMA MAR Art. 19 form in Portuguese):
 *   - ISIN (PTXXXXXXXXXX)
 *   - Company name (from 3a Nome in ESMA form)
 *   - Insider name (from 4a Código de identificação narrative)
 *   - Role (from form narrative, e.g. "membro do Conselho de Administração")
 *   - Transaction type (Aquisição → BUY, Alienação → SELL)
 *   - Price per share (EUR)
 *   - Shares (volume)
 *   - Transaction date (YYYY-MM-DD)
 *   - LEI, market
 *
 * GitHub Actions: requires poppler-utils for pdftotext.
 *   Add before this step: sudo apt-get install -y poppler-utils
 */
'use strict';

const puppeteer              = require('puppeteer');
const { execSync }           = require('child_process');
const fs                     = require('fs');
const path                   = require('path');
const { saveInsiderTransactions } = require('./lib/db');
const { translateRole }           = require('./lib/translate');
const { isinToTicker }            = require('./lib/isinToTicker');
const { looksLikeCorp }           = require('./lib/entityUtils');

const COUNTRY_CODE   = 'PT';
const SOURCE         = 'CMVM Portugal';
const RETENTION_DAYS = parseInt(process.env.LOOKBACK_DAYS || '14');
const CURRENCY       = 'EUR';
// Sequential fetching (=1) avoids CMVM session conflicts where multiple
// concurrent Puppeteer pages cause the server to return wrong cached PDFs.
const CONCURRENCY    = 1;

// CMVM portal is hard-capped at 30 most recent TRAN items (OutSystems DataActionGetReports,
// MaxRecords: 30). Pagination via StartIndex returns HTTP 403 server-side; date filters
// in the UI cannot be activated from Puppeteer (OutSystems React state management requires
// internal event propagation that dispatchEvent does not trigger). If Portuguese insider
// transaction volume exceeds ~30 filings per RETENTION_DAYS window, older items will be
// silently truncated. This check detects that condition and triggers an alert.
const CMVM_ITEM_CAP       = 30;
// Threshold: warn if oldest visible item is fewer than this many days old
const CAP_WARN_DAYS       = 14;
const CAP_ALERT_DAYS      = 7;
const ALERT_EMAIL         = process.env.NOTIFY_OWNER_EMAIL || 'jcdeboer@yahoo.com';

// CMVM SDI Emitentes page (parent of Transações de dirigentes)
const CMVM_SDI_URL = 'https://www.cmvm.pt/PInstitucional/Content?Input=2B37E09A59A0DF80BE92EC680DBABCB75C076B608267088F60A006ACD2620D69';

// The generic "Transações de dirigentes" feed (fetchTranList) shows only the
// most recent CMVM_ITEM_CAP (30) items ACROSS ALL PT issuers combined — a
// large but infrequent filer's transactions can be pushed out of that window
// entirely by a handful of small/mid-caps that file often (verified: VAA
// alone occupied 13 of 30 slots on 2026-07-25). This silently dropped PSI-20
// blue chips like Galp, EDP, and Sonae, which our DB had zero rows for despite
// them genuinely filing on CMVM.
//
// Fix: the portal's "Filtros" panel has an "Entidade" dropdown that filters
// DataActionGetReports to one issuer's OWN most-recent-30 — a completely
// separate 30-item window per company, unaffected by other issuers' volume.
// fetchWatchlistItems() below drives that filter for a curated list of large
// PT issuers known to be under-represented in the generic feed, merging their
// results into the main item list. Entity IDs (NUM_ENT) were confirmed live
// via the portal's own DataActionGetData EntitiesList response (514 total PT
// issuers) — hardcoded here since that full list rarely changes and re-fetching
// it every run just to look up 10 known IDs would be wasteful.
//
// Verified per-company: Galp (23179) and EDP (226) had 2026 filings entirely
// missing from our DB; Sonae (187) also had a 2026-06-02 filing missed.
// Jerónimo Martins (320) genuinely has no PDMR activity since 2024-08-01 (not
// a coverage bug — confirmed via its own entity-filtered history).
const PSI_WATCHLIST = [
  { id: '23179',  name: 'Galp Energia, SGPS, SA' },
  { id: '226',    name: 'EDP, S.A.' },
  { id: '320',    name: 'Jerónimo Martins - SGPS, SA' },
  { id: '187',    name: 'Sonae - SGPS, S.A.' },
  { id: '23002',  name: 'NOS, SGPS, S.A.' },
  { id: '432',    name: 'Banco Comercial Português, SA' },
  { id: '7394',   name: 'The Navigator Company, S.A.' },
  { id: '2367',   name: 'CTT - Correios de Portugal, S.A.' },
  { id: '174114', name: 'GREENVOLT - Energias Renováveis, S.A.' },
  { id: '544',    name: 'Corticeira Amorim - SGPS, SA' },
];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Defensive last-resort cleanup for the company field. The extraction below
// (section 3's "a) Nome ... b) LEI" block) is bounded to avoid picking up
// role/boilerplate text in the first place — this is a safety net for any
// layout variant not covered by that bounding.
const cleanPtCompany = (name) => {
  if (!name) return name;
  return name
    .replace(/,\s*sendo.*$/i, '')
    .replace(/^(Presidente|Administrador|Director|Gestor)\s+d[oae]\s+/i, '')
    .trim();
};

// ─── PDF text extraction ───────────────────────────────────────────────────────

function pdfBase64ToText(base64) {
  const buf = Buffer.from(base64, 'base64');
  const tmpFile = path.join('/tmp', `cmvm-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    fs.writeFileSync(tmpFile, buf);
    return execSync(`pdftotext "${tmpFile}" -`, { encoding: 'utf8', timeout: 15000 });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
}

// ─── PDF field parser ──────────────────────────────────────────────────────────

/**
 * Parse CMVM TRAN PDF text (from pdftotext).
 *
 * Two filing formats are used by Portuguese companies:
 *
 * Format A — Standard ESMA form in Portuguese (e.g. Novabase):
 *   Fields like "Dados das pessoas", "Cargo/estatuto", "Data da operação".
 *   Insider name appears in 4a narrative: "Pessoas com responsabilidades de direção: {name}"
 *
 * Format B — Free-text English (e.g. NOS):
 *   "...hereby informs on the transaction of NOS shares by {name}, Manager (Dirigente)"
 *   Table with "ISIN Code", "Price and Volume: € {price} (per share) / {N} shares"
 */
function parsePdfFields(text) {
  // ── Insider name ──────────────────────────────────────────────────────────────

  let insiderName = null;
  let viaEntity = null;

  // Closely-related-entity notifications: the Cargo/estatuto text names a
  // corporate entity as the closely-related party and a natural person it's
  // linked to. Three boilerplate phrasings seen in practice:
  //   A) "A presente notificação diz respeito à {ENTITY} enquanto Pessoa
  //      Estreitamente Relacionada com {PERSON}." (Flexdeal's Baddon S.A.
  //      filing, TRAN1289389.pdf)
  //   B) "...por força do exercício de cargo(s) de administração de {PERSON}
  //      na {ENTITY} e n[ao] emitente" (VAA's NCFTRADETUR filing,
  //      TRAN1289951.pdf)
  //   C) "Pessoa estreitamente relacionada: pessoa coletiva controlada por
  //      D. {PERSON}, ..." (EDP's Masaveu Internacional filing,
  //      TRAN1285150.pdf) — unlike A/B, this phrasing states only the
  //      person, not the entity; the entity is section 1's own "Nome" value
  //      instead, which (unlike Baddon/NCFTRADETUR) is NOT blank here — but
  //      the generic 1a fallback further below requires "a) Nome" adjacent
  //      with no text between them, which doesn't hold on this layout
  //      ("a)\n\nDados das pessoas...\nNome\n{entity}"), so it's resolved
  //      inline here instead of relying on that fallback.
  // Must run FIRST: this Cargo/estatuto text is exactly what the old company
  // extraction below used to mistake for the issuer name, and the real
  // person's name never appears via any of the other patterns in this
  // function for these filings.
  const relA = text.match(/diz respeito à\s+([\s\S]+?)\s+enquanto Pessoa\s*\n?\s*Estreitamente Relacionada com\s+([^\n.]{3,80})\./i);
  const relB = text.match(/de cargos?\s+de administra[çc][aã]o de\s+([\s\S]{3,150}?)\s+na\s*\n?\s*([^\n]{3,80}),?\s+e n[ao]\s+emitente/i);
  const relC = text.match(/pessoa coletiva controlada por\s+(?:D\.?\s*)?([^,]{3,80}),/i);
  if (relA) {
    viaEntity = relA[1].trim();
    insiderName = relA[2].trim();
  } else if (relB) {
    insiderName = relB[1].trim().replace(/\s+/g, ' ');
    viaEntity = relB[2].trim();
  } else if (relC) {
    const sec2IdxC = text.search(/Motivo da notifica[çc][aã]o/i);
    const sec1ScopeC = sec2IdxC === -1 ? text : text.slice(0, sec2IdxC);
    const entityMatchC = sec1ScopeC.match(/\bNome\s*\n\s*([A-Z][^\n]{3,150})/i);
    if (entityMatchC) {
      insiderName = relC[1].replace(/\s+/g, ' ').trim();
      viaEntity = entityMatchC[1].trim();
    }
  }

  // Format A: "Pessoas com responsabilidades de direção: Name\nSurname"
  if (!insiderName) {
    const ptNameMatch = text.match(
      /Pessoas com responsabilidades de dire[çc][aã]o:\s*([\s\S]+?)(?=\n\n|A presente)/
    );
    if (ptNameMatch) {
      insiderName = ptNameMatch[1]
        .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
    }
  }

  // Format B: "hereby informs on the transaction of ... shares by Name, Role"
  // Name may wrap to the next line (e.g. "Manuel António Neto Portugal\nRamalho Eanes,")
  // Use non-greedy [\s\S]+? to match the FIRST "by" occurrence, not the last.
  // The old [^b]+ would stop at any 'b' char then greedily backtrack to the rightmost
  // "by", which could be "...by With purchase instruction transmitted on..." in NOS PDFs.
  if (!insiderName) {
    const enNameMatch = text.match(
      /hereby informs on the transaction of [\s\S]+?by ([^,\n]{3,80}),/i
    );
    if (enNameMatch) insiderName = enNameMatch[1].trim().replace(/\s+/g, ' ');
  }

  // Fallback: ESMA standard English form section 1a "a) Name"
  if (!insiderName) {
    const sec1aEn = text.match(/\ba\)\s*Name\s*\n[\s\n]*([A-Z][^\n]{2,120})/);
    if (sec1aEn) insiderName = sec1aEn[1].trim();
  }

  // Fallback: some issuers' PDFs have a complex two-column table layout that
  // pdftotext linearizes out of order, so the 1a) Nome value ends up displaced
  // far from its label (verified on Flexdeal – SIMFE's TRAN1290486.pdf, where
  // the name appears mid-way through section 4's table instead of under 1a).
  // The CMVM standard boilerplate always restates the name in a sentence like
  // "<Name> é o/a <cargo>, sendo por isso Dirigente desta sociedade" right
  // after — that phrase is a reliable anchor regardless of where the table
  // scrambled the actual field position. Must run BEFORE the generic 1a)/Nome
  // fallback below: when section 1's Nome value is blank (as in this layout),
  // that fallback isn't anchored to section 1 and happily matches section 3's
  // "a) Nome" instead — the issuer's name, not the person's.
  // Portuguese names commonly include lowercase particles (da/de/do/dos/das)
  // between capitalized words — e.g. "Alberto Jorge da Silva Amaral".
  const PT_NAME_SHAPE = /^[A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:d[aeo]s?|e|[A-ZÀ-Ý][a-zà-ÿ.]+)){1,6}$/;

  if (!insiderName) {
    // Boilerplate wording varies: "sendo por isso" or "sendo, por isso,"
    // (verified on Flexdeal's TRAN1289388.pdf, which uses the comma form).
    const sendoMatch = text.match(/([^\n]{3,80})\n\n(?:[^\n]*\n){0,3}?[^\n]*\bsendo,?\s*por isso\b/i);
    if (sendoMatch) {
      const candidate = sendoMatch[1].trim();
      if (PT_NAME_SHAPE.test(candidate)) insiderName = candidate;
    }
  }

  // Fallback: some issuers displace the person's name into section 4's block
  // (transaction details) instead of section 1, due to the same column-
  // scrambling — verified on Conduril's TRAN1289706.pdf (name right after the
  // section 4 header) and Flexdeal's TRAN1289388.pdf (name right after item
  // 4's "b)" sub-label). Take the first standalone line in that block that
  // looks like a person's name and isn't a known field label.
  if (!insiderName) {
    const sec4Idx = text.search(/Dados da\(s\) transa[çc][aã]o/i);
    if (sec4Idx !== -1) {
      let endIdx = text.slice(sec4Idx).search(/Pre[çc]o\(s\)\s*e\s*volume\(s\)/i);
      endIdx = endIdx === -1 ? 600 : Math.min(endIdx, 600);
      const sec4Lines = text.slice(sec4Idx, sec4Idx + endIdx)
        .split('\n').map(l => l.trim()).filter(Boolean);
      const LABEL_BLOCKLIST = /^(?:[a-f]\)|\d+|Descri[çc][aã]o|C[oó]digo|Natureza|ISIN|Pre[çc]o|Volume|Informa[çc][oõ]es|Data|Local|A[çc][oõ]es|Aquisi[çc][aã]o|Aliena[çc][aã]o|Notifica[çc][aã]o)/i;
      const candidate = sec4Lines.find(l => PT_NAME_SHAPE.test(l) && !LABEL_BLOCKLIST.test(l));
      if (candidate) insiderName = candidate;
    }
  }

  // Fallback: 1a Nome field if filled. Bounded to before section 2's header
  // ("Motivo da notificação") so a blank section-1 Nome field can't spill over
  // and match a LATER section's "a) Nome" (e.g. section 3's issuer name) instead.
  if (!insiderName) {
    const sec2Idx = text.search(/Motivo da notifica[çc][aã]o/i);
    const sec1Scope = sec2Idx === -1 ? text : text.slice(0, sec2Idx);
    const sec1a = sec1Scope.match(/\ba\)\s*Nome\s*\n\s*([A-Z][^\n]{5,80})/);
    if (sec1a) insiderName = sec1a[1].trim();
  }

  // Post-extraction: reject names that contain transaction instruction/mechanism text.
  // NOS PDFs can write "...by With purchase instruction transmitted on YYYY-MM-DD – HHhMM,"
  // (describing the order execution method) which the Format B regex would pick up.
  if (insiderName) {
    const ARTIFACT_RE = /\binstruction\b|\btransmitted\b|\bpurchase\s+order\b/i;
    const ARTIFACT_START = /^(?:with|following|pursuant|per|order|via)\s+/i;
    if (ARTIFACT_RE.test(insiderName) || ARTIFACT_START.test(insiderName)) {
      console.log(`    ⚠  Discarding name artifact: "${insiderName.slice(0, 70)}"`);
      insiderName = null;
    }
  }

  // ── Role ─────────────────────────────────────────────────────────────────────

  let roleRaw = null;

  // Format A: "membro do Conselho de\nAdministração"
  const ptRoleMatch = text.match(
    /(?:membro d[ao]s?|na qualidade de)\s+([\s\S]+?)(?=\n\n|Notifica|Inicial)/
  );
  if (ptRoleMatch) {
    roleRaw = ptRoleMatch[1]
      .split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  }

  // Format B: "Name, Manager (Dirigente)" or "Name, Director"
  if (!roleRaw) {
    const enRoleMatch = text.match(
      /by [^,\n]+,\s*([^,\n(]+(?:\([^)]+\))?)/i
    );
    if (enRoleMatch) roleRaw = enRoleMatch[1].trim();
  }

  // Fallback: 2a Cargo/estatuto
  if (!roleRaw) {
    const cargoMatch = text.match(/Cargo\/estatuto\s+([^\n]{5,80})/i);
    if (cargoMatch) roleRaw = cargoMatch[1].trim();
  }

  // ── Company ───────────────────────────────────────────────────────────────────

  let company = null;

  // Format A: section 3's "a) Nome ... b) LEI" block — the issuer's own name,
  // bounded to end right before "b) LEI" so it can't spill into a scrambled
  // section 4. The old unbounded version (just "a) Nome" to the next "b)")
  // routinely captured role/boilerplate text from section 2 instead, since
  // section 1's own Nome field is reliably blank on these filers and that
  // text happens to contain a corporate suffix too — e.g. "Presidente do
  // Conselho de Administração da Conduril - Engenharia, S.A." (Conduril,
  // TRAN1289706.pdf) or "SIMFE, S.A., sendo, por isso, Dirigente da
  // Sociedade." (Flexdeal, TRAN1289388.pdf).
  const issuerBlock = text.match(/Dados sobre o emitente[\s\S]*?\ba\)\s*\n+\s*Nome\s*\n+\s*([^\n]{3,150})\n+\s*b\)\s*\n+\s*LEI/i);
  if (issuerBlock) company = issuerBlock[1].trim();

  // Fallback: some filers bundle the "a)"/"b)" and "Nome"/"LEI" labels
  // together BEFORE their values instead of interleaving label-value pairs
  // (verified on Samba Digital's TRAN1289488.pdf/TRAN1289489.pdf) — in that
  // layout the company name is simply the line immediately preceding an
  // 18-20 char LEI code. A third variant (verified on Ciagest's
  // TRAN1289028.pdf) restates a bare "LEI" label line BETWEEN the company
  // value and its code ("Nome\n{company}\nLEI\n{code}") — the optional
  // non-capturing group below bridges over that label line so it isn't
  // mistaken for the company name itself.
  if (!company) {
    const emitenteIdx = text.search(/Dados sobre o emitente/i);
    if (emitenteIdx !== -1) {
      const leiPair = text.slice(emitenteIdx, emitenteIdx + 400)
        .match(/([^\n]{3,150})\n(?:LEI(?:\s*\(\d+\))?\s*\n)?([A-Z0-9]{18,20})\b/i);
      if (leiPair) company = leiPair[1].trim();
    }
  }

  // Format B: "Issuer Company\n\n{name}" or "Issuer Company  {name}"
  if (!company) {
    const issuerMatch = text.match(/Issuer Company\s+([\s\S]+?)(?:\n\n|LEI)/);
    if (issuerMatch) {
      // Filter out dates, timestamps, and transaction instruction lines
      // e.g. "2026-03-31 – 08h00 WEST" or "With purchase instruction transmitted on 2026-03-20"
      const lines = issuerMatch[1].split('\n').map(l => l.trim()).filter(l =>
        l.length > 2 &&
        !/^\d{4}-\d{2}-\d{2}/.test(l) &&
        !/^\d{2}[hH]\d{2}/.test(l) &&
        !/\binstruction\b|\btransmitted\b/i.test(l) &&
        !/^(?:with|following|pursuant)\s+/i.test(l)
      );
      if (lines.length) company = lines.join(' ').slice(0, 150);
    }
  }

  // Defensive cleanup regardless of which path found the company — strip
  // trailing legal boilerplate and leading role/title prefixes that could
  // still slip through on layouts not covered above.
  company = cleanPtCompany(company);

  // ── ISIN ─────────────────────────────────────────────────────────────────────

  // Flexible: match "ISIN" or "ISIN Code" followed (within ~100 chars) by the ISIN code
  let isinM = text.match(/ISIN(?:\s+Code)?\s*[\s\S]{0,80}?([A-Z]{2}[A-Z0-9]{9}[0-9])/);
  // Fallback: ESMA table format — ISIN appears before "Identification code" label
  if (!isinM) isinM = text.match(/([A-Z]{2}[A-Z0-9]{9}[0-9])[\s\n]*(?:type of instrument[\s\n]*)?Identification code/);
  // Fallback: any ISIN-shaped string in the text
  if (!isinM) isinM = text.match(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/);
  const isin = isinM ? isinM[1] : null;

  // ── LEI ──────────────────────────────────────────────────────────────────────
  const leiMatch = text.match(/\bLEI\b\s+([A-Z0-9]{20})/i);
  const lei = leiMatch ? leiMatch[1] : null;

  // ── Transaction type ──────────────────────────────────────────────────────────
  // "Compra"/"Venda" (Purchase/Sale) are colloquial synonyms for the legally
  // mandated "Aquisição"/"Alienação" terms — official ESMA-standard filings
  // consistently use the latter, but narrative-style disclosures occasionally
  // use the former.
  //
  // Deliberately NOT matching bare "Exercício" (option exercise) here: every
  // CMVM filing includes the standard MAR Art. 19(6)(e) disclaimer sentence
  // ("...não está associada ao exercício de programas de opções sobre
  // ações...") regardless of whether the transaction is a BUY or a SELL, so a
  // bare "Exercício" match would misclassify genuine SELLs as BUY (isBuy is
  // checked first). A genuine option-exercise transaction is expected to
  // still say "Aquisição de ações" as its Natureza da operação value (matching
  // the ESMA standard transaction-nature taxonomy, where exercise is a form of
  // acquisition, not a separate code) and so is already correctly classified
  // as BUY without this pattern — matching every other market's scraper in
  // this codebase (Australia, Canada, Denmark, Finland, Luxembourg, South
  // Korea, UK all treat exercises as BUY; none use a separate "OPT" type,
  // relying instead on the downstream is_unusual_price flag in
  // flag-signals.js to distinguish nominal-price exercises from market buys).
  //
  // "Doação"/"Herança" (donation/inheritance) intentionally have no pattern
  // here and correctly fall through to OTHER.
  const isBuy  = /Aquisi[çc][aã]o|Acquisition of|purchased|Award of|Subscri|Compras?\b/i.test(text);
  const isSell = /Aliena[çc][aã]o|Sale of|sold|disposal|Vendas?\b/i.test(text);
  const transactionType = isBuy ? 'BUY' : isSell ? 'SELL' : 'OTHER';

  // ── Price per share ───────────────────────────────────────────────────────────

  let pricePerShare = null;

  // Format 0 (highest priority): "Preço médio: 4,2609 €/ ação" — the explicit
  // multi-execution weighted average, checked before any single-execution
  // price so it always wins when present (verified on EDP's TRAN1285150.pdf,
  // a 3-execution filing at €4.3130/€4.2013/€4.2909 individually — without
  // this check, the tightened "Preço:" pattern further below matches a bare
  // "Preço\n€4,3130/ação" from the per-execution breakdown instead, since
  // "Preço médio" isn't adjacent to "Volume" here the way Baddon's/Conduril's
  // aggregate sections are, so the combined aggBlock check later doesn't
  // catch it either). Matched independently of what follows it — unlike
  // aggBlock below, does not require an adjacent "Volume:" value.
  const avgPriceMatch = text.match(/Pre[çc]o\s+m[ée]dio:?\s*(\d+,\d{2,4})\s*€?/i);
  if (avgPriceMatch) {
    pricePerShare = parseFloat(avgPriceMatch[1].replace(',', '.'));
  }

  // Format A: "9,0000 EUR / ação"
  const ptPriceMatch = text.match(/(\d+(?:[,\.]\d+)*)\s*EUR\s*\/\s*a[çc][aã]o/i);
  if (ptPriceMatch) {
    pricePerShare = parseFloat(ptPriceMatch[1].replace(/\.(\d{3})/g, '$1').replace(',', '.'));
  }

  // Format B: "€ 5.45 (per share)"
  if (pricePerShare == null) {
    const enPriceMatch = text.match(/€\s*([\d,\.]+)\s*\(per share\)/i)
      || text.match(/(\d+(?:[,\.]\d+)*)\s*EUR\s*per\s*share/i);
    if (enPriceMatch) {
      pricePerShare = parseFloat(enPriceMatch[1].replace(',', '.'));
    }
  }

  // Format C: "Preço(s) e volume(s)" table cell — "Preço: € 5,00" on its own
  // line, no "/ação" or "(per share)" suffix (verified on Flexdeal's
  // TRAN1290486.pdf). Match "Preço" followed by the euro amount, anywhere in
  // the text — the label/value can be separated by a colon or a line break
  // depending on how pdftotext linearized the table. Requires a comma-decimal
  // amount (e.g. "5,05") to avoid matching a bare thousands-separated share
  // count like "13.000" that happens to follow a "Preço" label after table
  // scrambling (verified on Conduril's TRAN1289706.pdf).
  if (pricePerShare == null) {
    const precoMatch = text.match(/\bPre[çc]o\b\s*[:\n]\s*€?\s*(\d+,\d{2,4})/i);
    if (precoMatch) {
      pricePerShare = parseFloat(precoMatch[1].replace(',', '.'));
    }
  }

  // Format D: narrative "...valor de referência unitário 14,90 €" sentence in
  // the notification's intro paragraph (verified on Conduril's
  // TRAN1289706.pdf) — reliable plain prose, unaffected by table scrambling.
  if (pricePerShare == null) {
    const refMatch = text.match(/valor de refer[eê]ncia unit[aá]rio\s*([\d,\.]+)\s*€/i);
    if (refMatch) {
      pricePerShare = parseFloat(refMatch[1].replace(/\.(\d{3})/g, '$1').replace(',', '.'));
    }
  }

  // Format E: "Preço(s)\n\nVolume(s)\n\n{price}\n\n{shares} ações" — a
  // recurring layout where both field labels are bundled together first,
  // then both values follow in the same order (verified on Conduril's
  // TRAN1289706.pdf and Ciagest's TRAN1289028.pdf). Captures price and
  // shares together since they're positionally paired in this layout.
  const bundledPriceVol = text.match(/Pre[çc]o\(s\)\s*\n+\s*Volume\(s\)\s*\n+\s*(\d+,\d{2,4})\s*\n+\s*([\d.\s]+)\s*a[çc][õo]es/i);
  if (pricePerShare == null && bundledPriceVol) {
    pricePerShare = parseFloat(bundledPriceVol[1].replace(',', '.'));
  }

  // ── Shares (volume) ──────────────────────────────────────────────────────────

  let shares = null;

  // Format A: "7 029 ações" or "13.000 ações" (European format — space or
  // period thousands separator). Previously only allowed spaces, so a
  // period-separated count like "13.000" or "10.000" would fail to match
  // starting from the "1", fall back to matching just the digits after the
  // period ("000 ações"), and silently produce shares=0 (verified on
  // Conduril's TRAN1289706.pdf and Flexdeal's Baddon S.A. filing,
  // TRAN1289389.pdf). The digit run is restricted to same-line characters
  // (space, not \s) — an earlier version of this fix used \s, which also
  // matches newlines and let the match bleed across a paragraph break from
  // an unrelated preceding number's trailing digits (e.g. Ciagest's
  // TRAN1289028.pdf: "2,28\n\n90.000 ações" concatenated into "2890000"
  // instead of 90000, since the match started from the "28" tail of the
  // price value two lines above).
  const ptVolMatch = text.match(/(\d[\d. ]*)\s*a[çc][õo]es\b/i);
  if (ptVolMatch) {
    shares = parseInt(ptVolMatch[1].replace(/[.\s]/g, ''), 10);
  }

  // Format B: "/ 20,410 shares" (US/EN thousands separator with comma)
  if (!shares || isNaN(shares)) {
    const enVolMatch = text.match(/\/([\s,\d]+)\s*shares/i)
      || text.match(/([\d,]+)\s*shares/i);
    if (enVolMatch) {
      shares = parseInt(enVolMatch[1].replace(/[,\s]/g, ''), 10);
    }
  }

  // Format C: ESMA standard table "c) Price(s) and volume(s) ... €N.NNNN\n\nVOLUME d)"
  // Extract entire c)...d) block and parse price (€N.N) and volume separately
  if (pricePerShare == null || !shares || isNaN(shares)) {
    const esmaBlock = text.match(/c\)\s*Price\(s\)\s*and\s*volume\(s\)([\s\S]+?)d\)\s/i)?.[1] || '';
    if (esmaBlock) {
      if (pricePerShare == null) {
        // Try with € prefix first, then bare decimal number (e.g. "9.8700\n\n4 700")
        const eurM = esmaBlock.match(/€\s*([\d,\.]+)/)
          || esmaBlock.match(/\b(\d+[.,]\d{2,4})\s*\n+\s*[\d,]{3,}/);
        if (eurM) pricePerShare = parseFloat(eurM[1].replace(',', '.'));
      }
      if (!shares || isNaN(shares)) {
        // Volume appears after the price (€...) in the block — skip the price digits
        const volM = esmaBlock.match(/€[\d.,]+\s*\n+\s*([\d,\s]+)/)
          || esmaBlock.match(/\b\d+[.,]\d+\s*\n+\s*([\d,\s]{3,})/)
          || esmaBlock.match(/Volume\(s\)\s*\n[\s\S]*?\n\s*([\d]{1,3}(?:,[\d]{3})+)\s*\n/i);
        if (volM) shares = parseInt(volM[1].replace(/[,\s]/g, ''), 10);
      }
    }
  }

  // Format D: ESMA aggregated table — "N.NNNN EUR   N,NNN" on same/adjacent lines
  if (pricePerShare == null) {
    const aggM = text.match(/(\d+[.,]\d{2,4})\s+EUR\s+(\d[\d,\s]+)/i);
    if (aggM) {
      const p = parseFloat(aggM[1].replace(',', '.'));
      if (p > 0) pricePerShare = p;
      if (!shares || isNaN(shares)) {
        const s = parseInt(aggM[2].replace(/[,\s]/g, ''), 10);
        if (s > 0) shares = s;
      }
    }
  }

  if (isNaN(shares)) shares = null;

  // Multi-execution override: Portuguese CMVM forms use the same EU 2016/523
  // template as France, including an "Informações agregadas" (aggregate)
  // section for filings with more than one execution block — analogous to
  // France's "INFORMATIONS AGREGEES", which france.js already prefers (VWAP +
  // aggregate volume, the LAST "VOLUME:" occurrence) over any single
  // execution's values. Portugal previously had no equivalent: whichever
  // execution the earlier price/shares patterns matched first (usually just
  // the first) silently became the whole row, dropping every other execution
  // (verified on Flexdeal's Baddon S.A. filing, TRAN1289389.pdf: two
  // 10.000-share executions at €5.05 each were saved as a single 10.000-share
  // row instead of the true 20.000 aggregate — same bug class as the earlier
  // shares=0 fix, just for a different field). Prefer the aggregate values
  // here, matching france.js's approach.
  const aggBlock = text.match(/Pre[çc]o\s+m[ée]dio:?\s*€?\s*(\d+,\d{2,4})\s*\n+\s*Volume:?\s*(\d[\d. ]*)\s*a[çc][õo]es/i);
  if (aggBlock) {
    pricePerShare = parseFloat(aggBlock[1].replace(',', '.'));
    const aggShares = parseInt(aggBlock[2].replace(/[.\s]/g, ''), 10);
    if (aggShares > 0) shares = aggShares;
  } else {
    // No "Preço médio" (average price) present — single-execution filings
    // still restate the same total under "Volume agregado" with a bare
    // "Preço" that's often the TOTAL value in € rather than a per-share price
    // (verified on Conduril's TRAN1289706.pdf: "193.700 €" there is
    // price × shares, not a unit price) — so only take the shares side here.
    const aggSharesOnly = text.match(/Volume agregado[\s\S]{0,50}?(\d[\d. ]*)\s*a[çc][õo]es/i);
    if (aggSharesOnly) {
      const aggShares = parseInt(aggSharesOnly[1].replace(/[.\s]/g, ''), 10);
      if (aggShares > 0) shares = aggShares;
    }
  }

  // ── Transaction date ──────────────────────────────────────────────────────────

  // Format A: "Data da operação 2026-04-07"
  const ptDateMatch = text.match(/Data da opera[çc][aã]o\s+(\d{4}-\d{2}-\d{2})/i);
  // Format B/C: "Date of the transaction\n\n2026-04-13" or "Date  2026-03-31"
  const enDateMatch = text.match(/Date\s+of\s+the\s+transaction[\s\S]{0,10}?(\d{4}-\d{2}-\d{2})/i)
    || text.match(/\bDate\b\s+(\d{4}-\d{2}-\d{2})/i);
  const transactionDate = (ptDateMatch || enDateMatch || [])[1] || null;

  // ── Market ────────────────────────────────────────────────────────────────────
  const marketMatch = text.match(/(?:Local da opera[çc][aã]o|Place of the transaction|Location)\s+([^\n\d][^\n]{2,50})/i);
  const market = marketMatch ? marketMatch[1].trim() : null;

  return { insiderName, viaEntity, roleRaw, company, isin, lei, transactionType, pricePerShare, shares, transactionDate, market };
}

// ─── Role translation ─────────────────────────────────────────────────────────

const PT_ROLE_EXTRA = [
  [/conselho de administra[çc][aã]o/i, 'Board Member'],
  [/[oó]rg[aã]o de administra[çc][aã]o/i, 'Board Member'],
  [/comiss[aã]o executiva/i, 'Senior Executive'],
  [/presidente do conselho/i, 'Chairman'],
  [/conselho de supervis[aã]o/i, 'Board Member'],
  [/membro do conselho/i, 'Board Member'],
];

function translatePtRole(raw) {
  if (!raw) return null;
  for (const [pattern, english] of PT_ROLE_EXTRA) {
    if (pattern.test(raw)) return english;
  }
  return translateRole(raw);
}

// ─── Cap alert ────────────────────────────────────────────────────────────────

async function sendCapAlert(daysOld, oldestDate) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠  RESEND_API_KEY not set — cannot send cap alert email');
    return;
  }
  const subject = `InsidersAlpha: Portugal CMVM cap overflow detected`;
  const html = `
<p><strong>CMVM 30-item cap overflow detected</strong></p>
<p>The oldest visible TRAN filing is only <strong>${daysOld} days old</strong>
(${oldestDate}), meaning transactions from earlier dates are being silently
truncated by the portal's 30-item limit.</p>
<p><strong>Action required:</strong> Check
<a href="https://www.cmvm.pt/PInstitucional/Content?Input=2B37E09A59A0DF80BE92EC680DBABCB75C076B608267088F60A006ACD2620D69">CMVM SDI portal</a>
manually to identify any missed filings.</p>
<p style="color:#9CA3AF;font-size:12px">InsidersAlpha · Portugal scraper</p>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'InsidersAlpha Alerts <alerts@insidersalpha.com>',
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    });
    if (res.ok) console.log(`  📧 Cap alert email sent to ${ALERT_EMAIL}`);
    else console.warn(`  ⚠  Failed to send cap alert email: ${res.status}`);
  } catch(e) {
    console.warn(`  ⚠  Cap alert email error: ${e.message}`);
  }
}

// ─── Browser launch helper ────────────────────────────────────────────────────

function launchBrowser(chromiumPath) {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--js-flags=--max-old-space-size=512',
    ],
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });
}

// ─── Puppeteer navigation ─────────────────────────────────────────────────────

async function fetchTranList(browser) {
  const page = await browser.newPage();
  const items = [];

  // The portal fires DataActionGetReports more than once as the page loads and
  // as each menu click takes effect — the initial page load alone can trigger
  // a request for a different (non-TRAN) report section before either click
  // below ever runs. Taking the first non-empty response by arrival order is
  // a race condition: on unlucky timing it locks onto that earlier, wrong
  // section and every TRAN item downstream gets silently dropped (PDF_FACT
  // won't start with 'TRAN'), while the correct response that arrives moments
  // later is ignored. Instead, keep the LATEST response whose items actually
  // look like TRAN filings, so a late-arriving correct response always wins
  // over an earlier unrelated one.
  await page.setRequestInterception(true);
  page.on('request', req => req.continue());
  page.on('response', async res => {
    if (res.url().includes('DataActionGetReports')) {
      try {
        const json = await res.json();
        const list = json?.data?.ReportsList?.List || [];
        if (list.some(i => i.PDF_FACT?.startsWith('TRAN'))) {
          items.length = 0;
          items.push(...list);
        }
      } catch(e) {}
    }
  });

  // Retry initial navigation — CMVM portal is slow and occasionally times out
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CMVM_SDI_URL, { waitUntil: 'networkidle2', timeout: 120000 });
      break;
    } catch(e) {
      if (attempt >= 3) throw e;
      console.log(`  ⚠  CMVM portal navigation timeout (attempt ${attempt}/3), retrying in 10s…`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Click "Participações e operações sobre valores mobiliários"
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span, a, li'));
    const t = spans.find(el => el.textContent.trim().startsWith('Participações e operações'));
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  // Click "Transações de dirigentes"
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span, a, li'));
    const t = spans.find(el => el.textContent.trim() === 'Transações de dirigentes');
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  await page.close();
  return items;
}

// Drives the "Filtros" → "Entidade" dropdown for each PSI_WATCHLIST company in
// sequence within a single page session, capturing each one's own
// entity-filtered DataActionGetReports response (see PSI_WATCHLIST comment for
// why this is needed). Reuses the same page/session across companies — each
// filter change is a genuine UI-triggered request (search, select, click
// "Filtrar"), not a raw replay, which is required: CMVM's OutSystems backend
// invalidates the CSRF/request-token after a single use, so a byte-identical
// replayed request 403s even with zero parameters changed (verified directly).
async function fetchWatchlistItems(browser) {
  const page = await browser.newPage();
  const results = [];

  await page.setRequestInterception(true);
  page.on('request', req => req.continue());

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CMVM_SDI_URL, { waitUntil: 'networkidle2', timeout: 120000 });
      break;
    } catch(e) {
      if (attempt >= 3) { await page.close().catch(() => {}); return results; }
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('span, a, li')).find(el => el.textContent.trim().startsWith('Participações e operações'));
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('span, a, li')).find(el => el.textContent.trim() === 'Transações de dirigentes');
    if (t) t.click();
  });
  await new Promise(r => setTimeout(r, 6000));

  const filtrosOpened = await page.evaluate(() => {
    const btn = document.querySelector('#b114-b4-FiltersBtn')
      || Array.from(document.querySelectorAll('div, button')).find(el => el.textContent.trim() === 'Filtros');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!filtrosOpened) {
    console.log('  ⚠  Watchlist: could not open Filtros panel — skipping entity-specific fetch');
    await page.close().catch(() => {});
    return results;
  }
  await new Promise(r => setTimeout(r, 1500));

  for (const { id, name } of PSI_WATCHLIST) {
    let list = null;
    const onResponse = async (res) => {
      if (res.url().includes('Relatorio_NewFileLink/DataActionGetReports')) {
        try {
          const json = await res.json();
          const body = JSON.parse(res.request().postData());
          if (body.screenData.variables.EntitiesList === `'${id}'`) {
            list = json?.data?.ReportsList?.List || [];
          }
        } catch(e) {}
      }
    };
    page.on('response', onResponse);

    try {
      await page.click('.vscomp-ele-wrapper');
      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => { const el = document.querySelector('.vscomp-search-input'); if (el) el.value = ''; });
      // Search on a distinctive prefix rather than the full name — some
      // entries have trailing legal-form variants ("SGPS, SA" vs "SGPS, S.A.")
      // that a full-string match could miss.
      await page.type('.vscomp-search-input', name.split(',')[0], { delay: 60 });
      await new Promise(r => setTimeout(r, 1200));

      const optionClicked = await page.evaluate((targetId) => {
        const opt = Array.from(document.querySelectorAll('.vscomp-option')).find(el => el.getAttribute('data-value') === targetId);
        if (opt) { opt.click(); return true; }
        return false;
      }, id);
      if (!optionClicked) {
        console.log(`  ⚠  Watchlist: "${name}" (${id}) not found in Entidade dropdown — skipping`);
        continue;
      }
      await new Promise(r => setTimeout(r, 500));

      const filtrarClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Filtrar');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!filtrarClicked) {
        console.log(`  ⚠  Watchlist: "Filtrar" button not found for "${name}" — skipping`);
        continue;
      }
      await new Promise(r => setTimeout(r, 4000));

      if (list && list.length) {
        console.log(`  ℹ  Watchlist: ${name} — ${list.length} items (most recent: ${list[0]?.DATA_FACT})`);
        results.push(...list);
      } else {
        console.log(`  ℹ  Watchlist: ${name} — no items returned`);
      }
    } catch(e) {
      console.log(`  ⚠  Watchlist fetch failed for "${name}": ${e.message}`);
    } finally {
      page.off('response', onResponse);
    }
  }

  await page.close().catch(() => {});
  return results;
}

async function fetchPdfBase64(browser, encryptedURL) {
  const page = await browser.newPage();
  let base64 = null;

  await page.setRequestInterception(true);
  page.on('request', req => req.continue());
  page.on('response', async res => {
    if (res.url().includes('DataActionFetchDecriptInput')) {
      try {
        const json = await res.json();
        const b64 = json?.data?.FileBase64;
        if (b64 && b64.length > 1000) base64 = b64;
      } catch(e) {}
    }
  });

  // Retry up to 3 times for navigation timeouts.
  // Connection/target-closed errors are rethrown immediately — the outer loop
  // will restart the browser rather than retrying with a dead session.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(encryptedURL, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 4000));
      break;
    } catch(e) {
      const isConnectionErr = /connection closed|target closed|session closed|context.*destroyed/i.test(e.message);
      if (isConnectionErr) {
        await page.close().catch(() => {});
        throw e;  // propagate — caller will restart browser
      }
      if (attempt < 3) {
        console.log(`  ⚠  PDF navigation timeout (attempt ${attempt}/3), retrying…`);
        await new Promise(r => setTimeout(r, 10000));
      }
      // timeout on final attempt is OK — may have already captured response
    }
  }
  await page.close().catch(() => {});

  return base64;
}

// ─── Concurrency helper ────────────────────────────────────────────────────────

async function mapConcurrent(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function scrapePT() {
  console.log('🇵🇹  CMVM Portugal — MAR Article 19 management transactions');
  const t0 = Date.now();

  // Verify pdftotext is available
  try {
    execSync('pdftotext -v 2>&1', { encoding: 'utf8' });
  } catch(e) {
    // pdftotext writes version info to stderr, so non-zero exit is expected
    if (!/pdftotext/i.test(String(e.stderr || e.stdout || ''))) {
      console.log('  ⚠  pdftotext not found. Install poppler-utils:');
      console.log('       sudo apt-get install -y poppler-utils');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffIso = isoDate(cutoffDate);
  console.log(`  Fetching transactions since ${cutoffIso}…`);

  // Resolve Chromium path: env var → common Linux paths → puppeteer bundled cache.
  // Every candidate is verified with fs.existsSync() before being trusted — the
  // previous version returned process.env.PUPPETEER_EXECUTABLE_PATH and
  // puppeteer.executablePath() unconditionally, with no check that the binary
  // was actually still there. If a system Chromium install ever goes missing
  // (OS update, disk cleanup, a stale env var pointing at a path that was never
  // valid on this host), puppeteer.launch({executablePath: <ghost path>}) fails
  // almost instantly with an opaque spawn ENOENT — which is indistinguishable
  // from every other failure in scraper_runs (duration ~0.4-0.7s, no error text
  // captured there). This silently broke every PT run for 7+ weeks.
  const checked = [];
  function existingPath(p) {
    checked.push(p);
    try { return p && fs.existsSync(p) ? p : null; } catch { return null; }
  }
  function findChromium() {
    const envPath = existingPath(process.env.PUPPETEER_EXECUTABLE_PATH);
    if (envPath) return envPath;
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    for (const p of candidates) {
      const hit = existingPath(p);
      if (hit) return hit;
    }
    // Puppeteer's own downloaded browser (~/.cache/puppeteer/) — verify it's
    // actually present on disk, not just that the path computation succeeded.
    try {
      const bundled = existingPath(puppeteer.executablePath());
      if (bundled) return bundled;
    } catch {}
    return null;
  }

  let chromiumPath = findChromium();

  // Self-heal: nothing found anywhere — download Puppeteer's own Chrome build
  // on demand rather than crashing with no way to recover until someone
  // manually re-installs it on the host.
  if (!chromiumPath) {
    console.log(`  ⚠  No Chromium found (checked: ${checked.filter(Boolean).join(', ') || '(no candidates)'})`);
    console.log('  Attempting to install Chrome via puppeteer…');
    try {
      execSync('npx --yes puppeteer browsers install chrome', { stdio: 'inherit', timeout: 5 * 60 * 1000 });
      chromiumPath = existingPath(puppeteer.executablePath());
    } catch (e) {
      console.log(`  ⚠  Install attempt failed: ${e.message}`);
    }
  }

  if (!chromiumPath) {
    console.error(`  ❌ Could not find or install a working Chromium. Checked: ${checked.filter(Boolean).join(', ') || '(none)'}`);
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  console.log(`  Using Chromium: ${chromiumPath}`);

  let browser;
  try {
    browser = await launchBrowser(chromiumPath);
  } catch (e) {
    console.error(`  ❌ Failed to launch browser at ${chromiumPath}: ${e.message}`);
    console.log('  ℹ  0 rows saved.');
    return { saved: 0 };
  }

  try {
    // Step 1: Navigate and capture TRAN list
    console.log('  Navigating CMVM SDI portal…');
    const allItems = await fetchTranList(browser);

    if (!allItems.length) {
      console.log('  ⚠  DataActionGetReports returned no items — portal may be unavailable.');
      console.log('  ℹ  0 rows saved.');
      return { saved: 0 };
    }

    console.log(`  Found ${allItems.length} TRAN items in portal`);

    // ── Cap overflow check ────────────────────────────────────────────────────
    // The CMVM portal hard-limits responses to CMVM_ITEM_CAP (30) most recent items.
    // If we're AT the cap, check how old the oldest item is. If it's very recent,
    // higher-volume periods may be truncating older filings we need.
    // Must run on the generic feed BEFORE merging the PSI watchlist below —
    // watchlist companies are deliberately fetched regardless of age (Galp's
    // own history goes back to 2018), which would make this check's "oldest
    // item" wildly misleading about the generic feed's actual cap pressure.
    if (allItems.length >= CMVM_ITEM_CAP) {
      const tranOnly = allItems.filter(i => i.PDF_FACT?.startsWith('TRAN') && i.DATA_FACT);
      if (tranOnly.length > 0) {
        const oldest = tranOnly.reduce((a, b) => a.DATA_FACT < b.DATA_FACT ? a : b);
        const daysOld = Math.floor((Date.now() - new Date(oldest.DATA_FACT).getTime()) / 86_400_000);
        console.log(`  Oldest TRAN item: ${oldest.DATA_FACT} (${daysOld} days ago, PDF: ${oldest.PDF_FACT})`);

        if (daysOld < CAP_ALERT_DAYS) {
          console.warn(`  🚨 CAP OVERFLOW: oldest item only ${daysOld}d old — filings beyond day ${daysOld} are hidden`);
          await sendCapAlert(daysOld, oldest.DATA_FACT);
        } else if (daysOld < CAP_WARN_DAYS) {
          console.warn(`  ⚠  CAP WARNING: oldest item ${daysOld}d old — approaching 30-item limit (alert at < ${CAP_ALERT_DAYS}d)`);
        } else {
          console.log(`  ✓  Cap OK: ${daysOld} days of coverage visible`);
        }
      }
    }

    // Fetch each PSI_WATCHLIST company's own entity-filtered list — see the
    // comment above PSI_WATCHLIST for why the generic feed alone misses them.
    // Merge into allItems, deduping on PDF_FACT (the same key filing_id is
    // later derived from) since a watchlist company's items may legitimately
    // also appear in the generic feed when they're recent enough.
    console.log('  Checking PSI watchlist companies (Galp, EDP, Sonae, etc.)…');
    const watchlistItems = await fetchWatchlistItems(browser);
    const seenPdf = new Set(allItems.map(i => i.PDF_FACT));
    let addedFromWatchlist = 0;
    for (const item of watchlistItems) {
      if (item.PDF_FACT && !seenPdf.has(item.PDF_FACT)) {
        seenPdf.add(item.PDF_FACT);
        allItems.push(item);
        addedFromWatchlist++;
      }
    }
    if (addedFromWatchlist > 0) {
      console.log(`  ✓  Watchlist added ${addedFromWatchlist} new items not in the generic feed`);
    }

    // Step 2: Filter to TRAN items within date range.
    // CMVM publishes each notification in two languages (EN + PT) with consecutive PDF numbers.
    // Strategy: prefer IsEN=true items; include PT-only items where no EN equivalent exists.
    // Group by normalized company name + publication date to detect EN/PT pairs.

    const enItems = [];
    const ptItems = [];

    for (const item of allItems) {
      if (!item.PDF_FACT || !item.PDF_FACT.startsWith('TRAN')) continue;
      if (!item.DATA_FACT || item.DATA_FACT < cutoffIso) continue;
      if (item.IsEN) enItems.push(item);
      else ptItems.push(item);
    }

    // Build set of EN-covered (company+date) keys
    const enCovered = new Set(
      enItems.map(i => normKey(i))
    );

    function normKey(item) {
      // Strip language-dependent suffix to get company name
      const co = (item.DSC_FACT || '')
        .replace(/\s*informs?[^,]*$/i, '')
        .replace(/\s*informa.*$/i, '')
        .trim().toLowerCase();
      return `${item.DATA_FACT}-${co}`;
    }

    // PT-only items: those where no EN equivalent exists
    const ptOnly = ptItems.filter(i => !enCovered.has(normKey(i)));

    const toProcess = [...enItems, ...ptOnly];

    console.log(`  ${toProcess.length} unique TRAN notifications within last ${RETENTION_DAYS} days`);

    if (!toProcess.length) {
      console.log('  Nothing in retention window.');
      return { saved: 0 };
    }

    // Step 3: Download and parse each PDF — sequential with browser-restart on crash.
    // Each PDF gets up to 2 attempts; on a browser connection crash the browser is
    // relaunched and the PDF is retried once before being skipped.
    console.log(`  Downloading and parsing PDFs (sequential, restart-on-crash)…`);

    const parsed = [];
    for (let idx = 0; idx < toProcess.length; idx++) {
      const item = toProcess[idx];
      const pdfNum = item.PDF_FACT.replace(/\D/g, '');
      console.log(`    [${idx+1}/${toProcess.length}] ${item.PDF_FACT} — ${(item.DSC_FACT || '').slice(0, 60)}`);

      let result = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const base64 = await fetchPdfBase64(browser, item.EncryptedURL);
          if (!base64) {
            console.log(`      ⚠  Could not get PDF base64`);
            break;
          }
          let text;
          try {
            text = pdfBase64ToText(base64);
          } catch(e) {
            console.log(`      ⚠  pdftotext failed: ${e.message}`);
            break;
          }
          const fields = parsePdfFields(text);
          console.log(`      → ${fields.insiderName || '(no name)'} | ${fields.isin || '(no ISIN)'} | ${fields.transactionType} | ${fields.shares}@${fields.pricePerShare} | ${fields.transactionDate}`);
          result = { item, fields, pdfNum };
          break;
        } catch(err) {
          const isCrash = /connection closed|target closed|session closed|context.*destroyed/i.test(err.message);
          if (isCrash) {
            console.warn(`      ⚠  Browser crashed (${err.message.slice(0, 60)}), restarting…`);
            await browser.close().catch(() => {});
            browser = await launchBrowser(chromiumPath);
            if (attempt >= 2) {
              console.warn(`      ⚠  Skipping ${item.PDF_FACT} after 2 crash attempts`);
            }
            // loop continues to retry with fresh browser
          } else {
            console.warn(`      ⚠  Skipping ${item.PDF_FACT}: ${err.message.slice(0, 80)}`);
            break;
          }
        }
      }
      parsed.push(result);
    }

    // Step 4: Build DB rows
    // filing_id = PT-{pdfNum} is unique per PDF, so Supabase upsert handles
    // idempotency. No additional in-scraper dedup needed since we already
    // filtered to one version (EN preferred) per notification.
    const dbRows = [];

    for (const result of parsed) {
      if (!result) continue;
      const { item, fields, pdfNum } = result;

      // Derive company from PDF (3a Nome) or from notification DSC_FACT title
      const company = fields.company
        || (item.DSC_FACT || '').replace(/\s*informs?.*$/i, '').replace(/\s*informa.*$/i, '').trim()
        || null;

      const role = translatePtRole(fields.roleRaw);
      const totalValue = (fields.pricePerShare != null && fields.shares != null)
        ? Math.round(fields.pricePerShare * fields.shares)
        : null;

      dbRows.push({
        filing_id:        `PT-${pdfNum}`,
        country_code:     COUNTRY_CODE,
        ticker:           fields.isin ? (await isinToTicker(fields.isin, COUNTRY_CODE) || '') : '',
        company,
        insider_name:     (fields.insiderName && looksLikeCorp(fields.insiderName)) ? null : (fields.insiderName || null),
        via_entity:       fields.viaEntity || ((fields.insiderName && looksLikeCorp(fields.insiderName)) ? fields.insiderName : null),
        insider_role:     role || null,
        transaction_type: fields.transactionType,
        transaction_date: fields.transactionDate || item.DATA_FACT,
        shares:           fields.shares,
        price_per_share:  fields.pricePerShare,
        total_value:      totalValue,
        currency:         CURRENCY,
        filing_url:       item.EncryptedURL,
        source:           SOURCE,
      });
    }

    if (!dbRows.length) {
      console.log('  Nothing to save after parsing.');
      return { saved: 0 };
    }

    const { error } = await saveInsiderTransactions(dbRows);
    if (error) { console.error('  ❌ Supabase:', error.message); process.exit(1); }

    const buys  = dbRows.filter(r => r.transaction_type === 'BUY').length;
    const sells = dbRows.filter(r => r.transaction_type === 'SELL').length;
    console.log(`  ✅ ${((Date.now()-t0)/1000).toFixed(1)}s — ${dbRows.length} saved (${buys} BUY, ${sells} SELL)`);
    return { saved: dbRows.length };

  } finally {
    await browser.close();
  }
}

scrapePT().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
