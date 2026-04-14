'use strict';

/**
 * Translate insider_role strings to English.
 *
 * Rules are ordered most-specific → least-specific within each category.
 * Matching is case-insensitive against the trimmed input.
 *
 * Covers: DE, SE, DK, FI, FR, NL, IT, ES, PT, CZ, EN
 */

const ROLE_RULES = [
  // ── CEO / Managing Director ──────────────────────────────────────────────────
  [/président.directeur\s+général/i,            'CEO'],   // FR: PDG
  [/\bPDG\b/,                                   'CEO'],   // FR
  [/chief\s+executive\s+officer/i,              'CEO'],
  [/\bCEO\b/,                                   'CEO'],
  [/vorstandsvorsitzende?r?\b/i,                'CEO'],   // DE: Head of Management Board
  [/geschäftsführende[rn]?/i,                   'CEO'],   // DE: managing (adj)
  [/geschäftsführer/i,                          'CEO'],   // DE (word-boundary unreliable with ä)
  [/administrerende\s+direkt[øo]r/i,            'CEO'],   // DK
  [/verkställande\s+direktör/i,                 'CEO'],   // SE
  [/\bVD\b/,                                    'CEO'],   // SE: VD = CEO
  [/toimitusjohtaja/i,                          'CEO'],   // FI
  [/directeur\s+général/i,                      'CEO'],   // FR
  [/amministratore\s+delegato/i,                'CEO'],   // IT
  [/consejero\s+delegado/i,                     'CEO'],   // ES
  [/director\s+general/i,                       'CEO'],   // ES
  [/director.geral\b/i,                         'CEO'],   // PT
  [/administrador\s+delegado/i,                 'CEO'],   // PT
  [/directeur.generaal/i,                       'CEO'],   // NL
  [/managing\s+director/i,                      'CEO'],
  [/chief\s+exec/i,                             'CEO'],

  // ── Deputy / Acting CEO ──────────────────────────────────────────────────────
  [/deputy\s+(?:managing\s+)?(?:chief\s+executive|CEO)/i,  'Deputy CEO'],
  [/acting\s+(?:chief\s+executive|CEO)/i,                  'Acting CEO'],
  [/vd.vikarie/i,                                          'Acting CEO'],  // SE
  [/toimitusjohtajan\s+sijainen/i,                         'Deputy CEO'],  // FI

  // ── CFO ──────────────────────────────────────────────────────────────────────
  [/chief\s+financial\s+officer/i,              'CFO'],
  [/\bCFO\b/,                                   'CFO'],
  [/finanzvorstand/i,                           'CFO'],   // DE
  [/directeur\s+financ/i,                       'CFO'],   // FR
  [/director\s+financiero/i,                    'CFO'],   // ES
  [/direttore\s+finanziario/i,                  'CFO'],   // IT
  [/diretor\s+financeiro/i,                     'CFO'],   // PT
  [/talousjohtaja/i,                            'CFO'],   // FI
  [/finansdirektør/i,                           'CFO'],   // DK
  [/ekonomidirektör/i,                          'CFO'],   // SE
  [/finanschef/i,                               'CFO'],   // SE
  [/chief\s+financial/i,                        'CFO'],

  // ── COO ──────────────────────────────────────────────────────────────────────
  [/chief\s+operating\s+officer/i,              'COO'],
  [/\bCOO\b/,                                   'COO'],
  [/operativ\s+direktör/i,                      'COO'],   // SE
  [/driftsdirektør/i,                           'COO'],   // DK
  [/operatiivinen\s+johtaja/i,                  'COO'],   // FI

  // ── CTO ──────────────────────────────────────────────────────────────────────
  [/chief\s+(?:technology|technical)\s+officer/i, 'CTO'],
  [/\bCTO\b/,                                   'CTO'],
  [/teknologidirektør/i,                        'CTO'],   // DK
  [/teknologichef/i,                            'CTO'],   // SE

  // ── Other C-Suite ─────────────────────────────────────────────────────────────
  [/chief\s+investment\s+officer/i,             'CIO'],
  [/chief\s+information\s+officer/i,            'CIO'],
  [/\bCIO\b/,                                   'CIO'],
  [/chief\s+legal\s+officer/i,                  'CLO'],
  [/general\s+counsel/i,                        'General Counsel'],
  [/chief\s+commercial\s+officer/i,             'CCO'],
  [/chief\s+marketing\s+officer/i,              'CMO'],
  [/chief\s+risk\s+officer/i,                   'CRO'],
  [/chief\s+human\s+resources\s+officer/i,      'CHRO'],
  [/chief\s+strategy\s+officer/i,               'CSO'],

  // ── Chairman ──────────────────────────────────────────────────────────────────
  [/aufsichtsratsvorsitzende?r?\b/i,            'Chairman'],  // DE
  [/vorsitzende?r?\s+des\s+aufsichtsrats/i,     'Chairman'],  // DE
  [/styrelseordförande/i,                       'Chairman'],  // SE
  [/bestyrelsesformand/i,                       'Chairman'],  // DK
  [/hallituksen\s+puheenjohtaja/i,              'Chairman'],  // FI
  [/président\s+du\s+conseil/i,                 'Chairman'],  // FR
  [/président(?:e)?\s+(?:non.exéc|du\s)/i,     'Chairman'],  // FR non-exec
  [/presidente\s+del\s+consiglio/i,             'Chairman'],  // IT
  [/presidente\s+del\s+consejo/i,               'Chairman'],  // ES
  [/presidente\s+do\s+conselho/i,               'Chairman'],  // PT
  [/voorzitter\b/i,                             'Chairman'],  // NL
  [/ordförande/i,                               'Chairman'],  // SE
  [/\bchairman\b/i,                             'Chairman'],
  [/\bchairperson\b/i,                          'Chairman'],
  [/\bchairwoman\b/i,                           'Chairman'],

  // ── Board Member ─────────────────────────────────────────────────────────────
  [/non.executive\s+director/i,                 'Non-Executive Director'],
  [/member\s+of\s+(?:the\s+)?(?:administrative|management|supervisory)/i, 'Board Member'],  // FSMA BE
  [/board\s+(?:of\s+directors\s+)?member/i,     'Board Member'],
  [/member\s+of\s+the\s+board/i,                'Board Member'],
  [/aufsichtsratsmitglied/i,                    'Board Member'],  // DE
  [/\baufsichtsrat\b/i,                         'Board Member'],  // DE (Supervisory Board)
  [/styrelseledamot/i,                          'Board Member'],  // SE
  [/bestyrelsesmedlem/i,                        'Board Member'],  // DK
  [/hallituksen\s+jäsen/i,                      'Board Member'],  // FI
  [/administrateur/i,                           'Board Member'],  // FR
  [/consigliere/i,                              'Board Member'],  // IT
  [/\bconsejero\b/i,                            'Board Member'],  // ES
  [/\badministrador\b/i,                        'Board Member'],  // PT
  [/\bcommissaris\b/i,                          'Board Member'],  // NL
  [/raad\s+van\s+commissarissen/i,              'Board Member'],  // NL
  [/raad\s+van\s+bestuur/i,                     'Board Member'],  // NL management board
  [/člen\s+představenstva/i,                    'Board Member'],  // CZ management board
  [/člen\s+dozorčí\s+rady/i,                   'Board Member'],  // CZ supervisory board
  [/member\s+of\s+supervisory/i,                'Board Member'],
  [/supervisory\s+board/i,                      'Board Member'],
  [/\bboard\s+member\b/i,                       'Board Member'],
  [/\bboard\s+director\b/i,                     'Board Member'],

  // ── Executive Director / Vorstand ────────────────────────────────────────────
  [/executive\s+director/i,                     'Executive Director'],
  [/vorstandsmitglied/i,                        'Executive Director'],  // DE management board member
  [/\bvorstand\b/i,                             'Executive Director'],  // DE management board
  [/membro\s+do\s+conselho/i,                   'Executive Director'],  // PT
  [/membre\s+du\s+directoire/i,                 'Executive Director'],  // FR
  [/membro\s+del\s+consiglio/i,                 'Executive Director'],  // IT

  // ── Senior VP / VP ───────────────────────────────────────────────────────────
  [/senior\s+vice\s+president/i,                'Senior VP'],
  [/\bSVP\b/,                                   'Senior VP'],
  [/vice\s+president/i,                         'Vice President'],
  [/\bVP\b/,                                    'Vice President'],

  // ── Director (generic) ───────────────────────────────────────────────────────
  [/\bdirector\b/i,                             'Director'],
  [/\bdirecteur\b/i,                            'Director'],  // FR/NL
  [/\bdirektor\b/i,                             'Director'],  // DE
  [/\bdiretor\b/i,                              'Director'],  // PT
  [/\bdirettore\b/i,                            'Director'],  // IT

  // ── Major Shareholder ────────────────────────────────────────────────────────
  [/significant\s+shareholder/i,                'Major Shareholder'],
  [/major\s+shareholder/i,                      'Major Shareholder'],
  [/hauptaktionär/i,                            'Major Shareholder'],  // DE
  [/großaktionär/i,                             'Major Shareholder'],  // DE

  // ── Senior Executive ──────────────────────────────────────────────────────────
  [/\bsenior\s+executive\b/i,                   'Senior Executive'],  // FSMA BE
  [/\bsenior\s+manager\b/i,                     'Senior Executive'],

  // ── Korean (KR) ──────────────────────────────────────────────────────────────
  [/대표이사/,                                   'CEO'],        // KR: representative director = CEO
  [/최고경영자/,                                  'CEO'],        // KR: chief executive officer
  [/사장/,                                       'President'],  // KR: president
  [/부사장/,                                     'Vice President'], // KR: vice president
  [/전무이사/,                                   'Executive Director'], // KR: senior managing director
  [/상무이사/,                                   'Executive Director'], // KR: managing director
  [/이사회의장/,                                  'Chairman'],   // KR: board chairman
  [/사외이사/,                                   'Non-Executive Director'], // KR: outside director
  [/이사/,                                       'Board Member'], // KR: director/board member
  [/감사/,                                       'Board Member'], // KR: auditor (supervisory role)
  [/CFO|최고재무책임자/,                          'CFO'],        // KR
  [/COO|최고운영책임자/,                          'COO'],        // KR
  [/CTO|최고기술책임자/,                          'CTO'],        // KR
  [/주요주주/,                                   'Major Shareholder'], // KR: major shareholder

  // ── Related Party ────────────────────────────────────────────────────────────
  [/closely\s+associated/i,                     'Related Party'],
  [/nahe\s+stehende\s+person/i,                 'Related Party'],  // DE
  [/person\s+in\s+close/i,                      'Related Party'],
  [/\bPMA\b/,                                   'Related Party'],  // Person Discharging Managerial Responsibilities — related
];

/**
 * Translate a raw insider role string to English.
 * Returns the trimmed original if no mapping is found.
 * Returns null for null/empty input.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function translateRole(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const [pattern, english] of ROLE_RULES) {
    if (pattern.test(trimmed)) return english;
  }
  return trimmed;
}

module.exports = { translateRole };
