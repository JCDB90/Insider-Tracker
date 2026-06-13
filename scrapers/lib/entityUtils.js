'use strict';

// Legal suffixes that indicate a corporate entity (end of name)
const CORP_SUFFIX_RE = /\b(?:A\.?S\.?A?\.?|N\.?V\.?|B\.?V\.?|S\.?R\.?L\.?|S\.?p\.?A\.?|S\.?A\.?S?\.?|S\.?L\.?U?\.?|S\.?A\.?U?\.?|Ltd\.?|Limited|L\.?L\.?C\.?|L\.?L\.?P\.?|GmbH|mbH|A\.?G\.?|Aktiengesellschaft|Aktiebolag|Inc\.?|Corp\.?|P\.?L\.?C\.?|A\/S|Oy|A\.?B\.?|S\.?E\.?|KGaA|SPRL|BVBA|SCA|SCS|SARL|SASU|CVA|SNC|ApS|UG|GbR|OHG|KG|Pte\.?\s*Ltd\.?|ehf\.?|slf\.?|Corporation|Incorporated)\s*[.,)]*(?:\s*\([^)]*\))?\s*$/i;

// Corporate keywords appearing anywhere in the name
const CORP_KEYWORD_RE = /\b(?:Holdings?|Investments?|Participations?|Beteiligungen?|Beteiligungsgesellschaft|Vermögensverwaltung|Capital\s+(?:Management|Partners|Advisors)|Partners?(?:\s+LP|\s+LLP)?|(?:Asset\s+)?Management\s+(?:Ltd|LLC|GmbH|AG|SA|BV|AS)|Ventures?(?:\s+Ltd)?|Enterprises?|Industries|Solutions|Properties|Family\s+Office|Advisors?\s+(?:Ltd|LLC|GmbH|SA)|Consulting\s+(?:Ltd|LLC|GmbH|SA))\b/i;

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

/**
 * Split AMF "closely associated" name strings. Two form layouts:
 *   1. "PERSON personne liée à ENTITY"   → person is on the left
 *   2. "ENTITY personne morale liée à PERSON" → entity on left, person on right
 * Returns { person, entity } or null if no match.
 */
function splitFrPersonLiee(text) {
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
  return { person: left, entity: right };
}

module.exports = { looksLikeCorp, looksLikeAddress, splitFrPersonLiee };
