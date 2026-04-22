'use strict';

// Legal suffixes that indicate a corporate entity (end of name)
const CORP_SUFFIX_RE = /\b(?:A\.?S\.?A?\.?|N\.?V\.?|B\.?V\.?|S\.?R\.?L\.?|S\.?p\.?A\.?|S\.?A\.?S?\.?|Ltd\.?|L\.?L\.?C\.?|GmbH|A\.?G\.?|Inc\.?|P\.?L\.?C\.?|A\/S|Oy|A\.?B\.?|S\.?E\.?|KGaA|SPRL|BVBA|SCA|SCS|SARL|SASU|CVA|SNC)\s*[.,)]*\s*$/i;

// Corporate keywords appearing anywhere in the name
const CORP_KEYWORD_RE = /\b(?:Holdings?|Investments?|Capital\s+(?:Management|Partners|Advisors)|Partners?(?:\s+LP|\s+LLP)?|(?:Asset\s+)?Management\s+(?:Ltd|LLC|GmbH|AG|SA|BV|AS)|Ventures?(?:\s+Ltd)?|Enterprises?|Industries|Solutions|Properties|Family\s+Office|Advisors?\s+(?:Ltd|LLC|GmbH|SA)|Consulting\s+(?:Ltd|LLC|GmbH|SA))\b/i;

/**
 * Returns true if the name looks like a corporate entity rather than a person.
 */
function looksLikeCorp(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 2) return false;
  // Normalize: NFD decompose + strip combining diacritics so accented letters
  // like Ñ don't create false \b word boundaries (e.g. "DUEÑAS" → "DUENAS").
  const normalized = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (CORP_SUFFIX_RE.test(normalized)) return true;
  if (CORP_KEYWORD_RE.test(normalized)) return true;
  // Org number pattern: "Name (987654321)" or "Name (org.nr. 987654321)"
  if (/\(\s*(?:org\.?\s*nr\.?\s*)?[\d\s]{6,11}\s*\)/.test(n)) return true;
  return false;
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

module.exports = { looksLikeCorp, splitFrPersonLiee };
