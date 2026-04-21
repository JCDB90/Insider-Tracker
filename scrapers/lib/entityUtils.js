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
  if (CORP_SUFFIX_RE.test(n)) return true;
  if (CORP_KEYWORD_RE.test(n)) return true;
  // Org number pattern: "Name (987654321)" or "Name (org.nr. 987654321)"
  if (/\(\s*(?:org\.?\s*nr\.?\s*)?[\d\s]{6,11}\s*\)/.test(n)) return true;
  return false;
}

/**
 * Split "NAME personne liée à ENTITY" (French AMF form for closely associated persons).
 * Returns { person, entity } or null if no match.
 */
function splitFrPersonLiee(text) {
  if (!text) return null;
  const m = text.match(/^(.+?)\s+personne\s+li[eé]e?\s+[àa]\s+(.+)$/i);
  if (!m) return null;
  return { person: m[1].trim(), entity: m[2].trim() };
}

module.exports = { looksLikeCorp, splitFrPersonLiee };
