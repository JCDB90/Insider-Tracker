'use strict';

// Legal suffixes that indicate a corporate entity (end of name)
// S\.?C\.?A\.? / S\.?C\.?S\.? (not bare SCA/SCS) so the common dotted Luxembourg/
// French forms "S.C.A." and "S.C.S." (Société en Commandite par Actions/Simple)
// match too — observed live: "Analytical Bioventures S.C.A" wasn't caught by a
// bare "SCA" literal, letting the whole entity name fall through as if it were a
// person (EUROFINS SCIENTIFIC SE / LU-OAM-260297 filing).
// Sdn\.?\s*Bhd\.? / Berhad: Malaysian entity suffixes — several SGX-listed
// issuers have Malaysian parent/nominee entities in their substantial-
// shareholder chains (e.g. Top Glove Corporation Bhd, TSH Resources Berhad).
// "& Co." trailing: classic Anglo-American bank/brokerage naming (confirmed
// live: "JPMorgan Chase & Co." named as an SGX substantial shareholder,
// slipping through as if it were a person — none of the other suffixes
// above match a bare "Co."). Matches the literal "&" (now decoded at parse
// time in singapore.js's getTags) as well as a raw un-decoded "&amp;" HTML
// entity, since historical rows were saved before that decoding fix existed.
// Note: the "&/&amp; Co." alternative sits outside the leading \b — "&" is a
// non-word char abutting another non-word char (a space), so no \w/\W
// boundary exists there for \b to anchor on.
const CORP_SUFFIX_RE = /(?:\b(?:A\.?S\.?A?\.?|N\.?V\.?|B\.?V\.?|S\.?R\.?L\.?|S\.?p\.?A\.?|S\.?A\.?S?\.?|S\.?L\.?U?\.?|S\.?A\.?U?\.?|Ltd\.?|Limited|L\.?L\.?C\.?|L\.?L\.?P\.?|GmbH|mbH|A\.?G\.?|Aktiengesellschaft|Aktiebolag|Inc\.?|Corp\.?|P\.?L\.?C\.?|A\/S|Oy|A\.?B\.?|S\.?E\.?|KGaA|SPRL|BVBA|S\.?C\.?A\.?|S\.?C\.?S\.?|SARL|SASU|CVA|SNC|ApS|UG|GbR|OHG|KG|Pte\.?\s*Ltd\.?|Sdn\.?\s*Bhd\.?|Berhad|ehf\.?|slf\.?|Corporation|Incorporated)|(?:&|&amp;)\s*Co\.?)\s*[.,)]*(?:\s*\([^)]*\))?\s*$/i;

// Corporate keywords appearing anywhere in the name. Fund(s)/Trust/ETF added
// after confirming live SGX substantial-shareholder filings naming "Ginko-
// AGT Global Growth Fund" and "American Century ETF Trust - Avantis
// International Small Cap Value ETF" as the disclosing party — fund/trust
// vehicles, not individuals, but caught by none of the suffix patterns above.
const CORP_KEYWORD_RE = /\b(?:Holdings?|Investments?|Participations?|Beteiligungen?|Beteiligungsgesellschaft|Vermögensverwaltung|Capital\s+(?:Management|Partners|Advisors)|Partners?(?:\s+LP|\s+LLP)?|(?:Asset\s+)?Management\s+(?:Ltd|LLC|GmbH|AG|SA|BV|AS)|Ventures?(?:\s+Ltd)?|Enterprises?|Industries|Solutions|Properties|Family\s+Office|Advisors?\s+(?:Ltd|LLC|GmbH|SA)|Consulting\s+(?:Ltd|LLC|GmbH|SA)|Funds?|Trust|ETF)\b/i;

// Full-form French/Italian/Spanish corporate entity names written out in the filing
const CORP_FULLFORM_RE = /\b(?:soci[eé]t[eé]\s+(?:civile|anonyme|par\s+actions|en\s+commandite|d.investissement|de\s+gestion)|soci[eé]t[eé]\s+[àa]\s+responsabilit[eé]|s\.?a\.?s\.?\b|s\.?c\.?i\.?\b|soci[eé]dad\s+(?:an[oó]nima|limitada|de\s+inversi[oó]n)|societ[àa]\s+(?:per\s+azioni|semplice|a\s+responsabilit[àa])|gmbh\s*&\s*co|kommanditgesellschaft|stiftung|genossenschaft)\b/i;

// Spaced SARL variant used in Luxembourg: "S. a r.l.", "S.à r.l.", "S.a.r.l."
const LU_SARL_RE = /\bS\.\s*[aà]\.?\s*r\.?\s*l\.?\b/i;

// Street address with European postal code: "23, Val Fleuri, L-1526 Luxembourg"
const ADDRESS_RE = /^\d+[,.]?\s+\w.*[A-Z]{1,3}-\d{3,5}/;

/**
 * Returns true if the name looks like a corporate entity rather than a person.
 */
function looksLikeCorp(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 2) return false;
  // Normalize: NFD decompose + strip combining diacritics so accented letters
  // like Ñ don't create false \b word boundaries (e.g. "DUEÑAS" → "DUENAS").
  const normalized = n.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (CORP_SUFFIX_RE.test(normalized)) return true;
  if (CORP_KEYWORD_RE.test(normalized)) return true;
  if (CORP_FULLFORM_RE.test(n)) return true;
  if (LU_SARL_RE.test(n)) return true;
  // Prefix form: "A/S Motortramp", "N.V. SomeCorp" — legal suffix at start of name
  if (/^(?:A\/S|A\.S\.|N\.V\.|B\.V\.|S\.A\.|GmbH|AG|Oy|AB)\b/i.test(n)) return true;
  // "Société ..." / "Societe ..." — no legitimate person name starts with this word;
  // catches generic French company names with no recognizable trailing legal suffix
  // (e.g. "Société financière des Caoutchoucs \"SOCFIN\"", which CORP_FULLFORM_RE's
  // narrower "société civile/anonyme/par actions/..." list doesn't cover). Matched
  // against `normalized` (diacritics already stripped) — matching against the raw
  // accented string is fragile since a hand-typed "é" literal in source code isn't
  // guaranteed to be the same Unicode normalization form as the PDF-extracted text.
  if (/^societe\b/i.test(normalized)) return true;
  // Org number pattern: "Name (987654321)" or "Name (org.nr. 987654321)"
  if (/\(\s*(?:org\.?\s*nr\.?\s*)?[\d\s]{6,11}\s*\)/.test(n)) return true;
  return false;
}

/**
 * Returns true if the string looks like a street address rather than a person name.
 * Used to detect cases like "23, Val Fleuri, L-1526 Luxembourg".
 */
function looksLikeAddress(name) {
  if (!name || typeof name !== 'string') return false;
  return ADDRESS_RE.test(name.trim());
}

// French family/relationship terms filers sometimes put in the role field for
// a closely-associated person, instead of a corporate title — e.g. "Epouse
// Guillaume Robin" (wife of Guillaume Robin). A relationship term can never
// describe the reference PDMR (a spouse isn't a job title), only the actual
// closely-associated individual — see splitFrPersonLiee's swap below.
const FAMILY_RELATION_RE = /^(?:[EÉ]po(?:ux|use)|Conjoint[e]?|Concubin[e]?|Compagn(?:on|e)|Partenaire(?:\s+pacs[eé][e]?)?|Fils|Fille|Enfant|P[eè]re|M[eè]re|Fr[eè]re|S[oœ]ur)\b/i;

/**
 * Split AMF "closely associated" name strings. Two form layouts:
 *   1. "PERSON personne liée à ENTITY"   → person is on the left
 *   2. "ENTITY personne morale liée à PERSON" → entity on left, person on right
 * Returns { person, entity } or null if no match.
 *
 * `roleText`, if given, is the trailing role/description clause already split
 * off by the caller (e.g. "Directeur Général" or "Epouse Guillaume Robin") —
 * used to detect a THIRD layout AMF filers sometimes use for family-member
 * trades, confirmed live on Thermador Groupe: "Guillaume Jean ROBIN personne
 * liée à Laurence ROBIN, Epouse Guillaume Robin" — both sides are natural-
 * person names (so the corp-swap above doesn't fire), but the role clause
 * "Epouse Guillaume Robin" (wife of Guillaume Robin) can only describe
 * Laurence, not Guillaume (a person can't be their own spouse). Contrast with
 * Dassault Aviation's "Clément TRAPPIER personne liée à ERIC TRAPPIER,
 * Président-directeur général" — there the role IS a genuine corporate title
 * describing the right-hand name (Eric Trappier, Dassault's real PDG), so the
 * default left=person assignment (Clément, who actually traded) is correct
 * as-is. The two companies just fill in this free-text field in the opposite
 * order from each other; a family-relation-term role is the only reliable
 * signal available to tell which order a given filing used.
 */
function splitFrPersonLiee(text, roleText) {
  if (!text) return null;
  // Handle optional "morale" / "physique" between "personne" and "liée"
  const m = text.match(/^(.+?)\s+personne(?:\s+(?:morale|physique))?\s+li[eé]e?\s+[àa]\s+(.+)$/i);
  if (!m) return null;
  const left  = m[1].trim();
  const right = m[2].trim();
  // If the left side is a corporate entity and right is not, swap
  if (looksLikeCorp(left) && !looksLikeCorp(right)) {
    return { person: right, entity: left };
  }
  // Both sides are natural-person names — see doc comment above.
  if (roleText && FAMILY_RELATION_RE.test(roleText.trim()) && !looksLikeCorp(right)) {
    return { person: right, entity: left };
  }
  return { person: left, entity: right };
}

module.exports = { looksLikeCorp, looksLikeAddress, splitFrPersonLiee };
