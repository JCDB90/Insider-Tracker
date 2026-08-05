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
  // ── Deputy CEO / DG Délégué / DG Adjoint ─────────────────────────────────────
  // Checked BEFORE the generic CEO / bare-DG patterns below — "directeur général
  // délégué" and "directeur général adjoint" both contain "directeur général" as
  // a substring, so if a generic "directeur général" pattern were checked first
  // it would match and return before ever reaching these more specific deputy
  // patterns. Confirmed live (2026-08-05): ENGIE's Pierre-François Riolacci,
  // Jean-Sébastien Blanc, Sébastien Arbola, Cécile Previeu, and Julia Maris are
  // ALL "Directeur(trice) Général(e) Adjoint(e)" on their own AMF filings, but
  // were all showing as "CEO" — partly this ordering issue, partly because the
  // spelled-out "adjoint(e)" phrase had no rule at all (only the bare "DGA"
  // abbreviation was covered).
  [/direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?\s+d[eé]l[eé]gu[eé][e]?/i, 'Deputy CEO'],   // FR: DGD, masc/fem
  [/direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?\s+adjoint[e]?/i,          'Deputy CEO'],   // FR: DGA, masc/fem
  [/deputy\s+(?:managing\s+)?(?:chief\s+executive|CEO)/i,  'Deputy CEO'],
  [/acting\s+(?:chief\s+executive|CEO)/i,                  'Acting CEO'],
  [/vd.vikarie/i,                                          'Acting CEO'],  // SE
  [/toimitusjohtajan\s+sijainen/i,                         'Deputy CEO'],  // FI
  [/\bDGA\b/,                                              'Deputy CEO'],  // FR: Directeur Général Adjoint
  [/\bDGD\b/,                                              'Deputy CEO'],  // FR: Directeur Général Délégué

  // ── CEO / Managing Director ──────────────────────────────────────────────────
  [/président.directeur\s+général/i,            'CEO'],   // FR: PDG
  [/\bPDG\b/i,                                  'CEO'],   // FR (pdg lowercase too)
  [/chief\s+executive\s+officer/i,              'CEO'],
  [/\bCEO\b/,                                   'CEO'],
  [/vorstandsvorsitzende?r?\b/i,                'CEO'],   // DE: Head of Management Board
  [/geschäftsführende[rn]?/i,                   'CEO'],   // DE: managing (adj)
  [/geschäftsführer/i,                          'CEO'],   // DE (word-boundary unreliable with ä)
  [/administrerende\s+direkt[øo]r/i,            'CEO'],   // DK
  [/verkställande\s+direktör/i,                 'CEO'],   // SE
  [/\bVD\b/,                                    'CEO'],   // SE: VD = CEO
  [/toimitusjohtaja/i,                          'CEO'],   // FI
  // FR: bare "Directeur(trice) Général(e)" WITHOUT a "Président-" prefix is NOT
  // reliably "the one CEO" of a company — French SAs (especially multi-brand
  // holding groups) can have several people carrying this exact title
  // concurrently, one per subsidiary. Confirmed live: Thermador Groupe's Lionel
  // Gres, Marylène Pattard, Frank Bourgois, and Laure Empereur all hold plain
  // "Directeur Général"/"DG" on their own AMF filings — none of them is the
  // group's actual chief executive, only Guillaume Jean Robin's "PDG"-labeled
  // filings represent that singular role (matched by the président-directeur
  // rule above, unaffected by this change). "Président-Directeur Général"/PDG
  // is the only FR title that unambiguously implies a single top executive, so
  // it's the only one still mapped to 'CEO' — bare DG maps to the more honest,
  // non-singularity-implying 'Managing Director' instead.
  [/direct(?:eur|rice)\s+g[eé]n[eé]ral[e]?/i,   'Managing Director'],   // FR bare DG (no Président- prefix)
  [/\bDG\b/,                                    'Managing Director'],   // FR bare DG abbreviation
  [/amministratore\s+delegato/i,                'CEO'],   // IT
  [/consejero\s+delegado/i,                     'CEO'],   // ES
  [/director\s+general/i,                       'CEO'],   // ES
  [/director.geral\b/i,                         'CEO'],   // PT
  [/administrador\s+delegado/i,                 'CEO'],   // PT
  [/directeur.generaal/i,                       'CEO'],   // NL
  [/managing\s+director/i,                      'CEO'],
  [/chief\s+exec/i,                             'CEO'],

  // ── CFO ──────────────────────────────────────────────────────────────────────
  [/chief\s+financial\s+officer/i,              'CFO'],
  [/\bCFO\b/,                                   'CFO'],
  [/finanzvorstand/i,                           'CFO'],   // DE
  [/direct(?:eur|rice)\s+financ/i,              'CFO'],   // FR male/female
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
  [/\bCCO\b/,                                   'CCO'],
  [/chief\s+marketing\s+officer/i,              'CMO'],
  [/\bCMO\b/,                                   'CMO'],
  [/chief\s+risk\s+officer/i,                   'CRO'],
  [/chief\s+human\s+resources\s+officer/i,      'CHRO'],
  [/chief\s+strategy\s+officer/i,               'CSO'],
  [/executive\s+vice\s+president/i,             'EVP'],
  [/\bEVP\b/,                                   'EVP'],
  [/financial\s+controller/i,                   'CFO'],
  [/\bCFO\b/,                                   'CFO'],
  [/general\s+manager/i,                        'CEO'],

  // ── Vice Chairman ─────────────────────────────────────────────────────────────
  [/vice[\s-]?pr[eé]sident/i,                  'Vice Chairman'],  // FR/ES/IT
  [/vicepresidente/i,                           'Vice Chairman'],  // ES/IT
  [/vice[\s-]?chairman/i,                       'Vice Chairman'],
  [/vicepr[eé]sident/i,                         'Vice Chairman'],  // FR compact
  [/næstformand/i,                              'Vice Chairman'],  // DK

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
  [/non.executive\s+chair(?:man)?/i,             'Non-Executive Chairman'],
  [/non.executive\s+director/i,                 'Non-Executive Director'],
  [/independent\s+director/i,                   'Independent Director'],
  [/administrateur?\s+ind[eé]pendant/i,         'Independent Director'],   // FR: administrateur indépendant
  [/administratrice?\s+ind[eé]pendant/i,        'Independent Director'],   // FR: female form
  [/ind[eé]pendant[e]?\s+(?:director|member|administrateur?)/i, 'Independent Director'],
  [/\bchair\b/i,                                'Chairman'],
  [/member\s+of\s+(?:the\s+)?(?:administrative|management|supervisory)/i, 'Board Member'],  // FSMA BE
  [/other\s+member.*(?:administrative|management|supervisory)/i, 'Board Member'],  // ESMA
  [/board\s+(?:of\s+directors\s+)?member/i,     'Board Member'],
  [/member\s+of\s+the\s+board/i,                'Board Member'],
  [/administratrice?\b/i,                       'Board Member'],  // FR: female/male admin
  [/\badminstr?ateur\b/i,                       'Board Member'],  // FR: typo variant
  [/membre\s+du\s+conseil\s+de\s+surveillance/i, 'Supervisory Board Member'],  // FR (BEFORE conseil d'admin)
  [/membre\s+du\s+conseil(?:\s+d['']?administration)?/i, 'Board Member'],  // FR
  [/membre\s+du\s+comit[eé]?\s+d['']?audit/i,  'Audit Committee Member'],  // FR
  [/\bexco\s+member\b/i,                        'Executive Committee Member'],
  [/censeur/i,                                  'Observer'],       // FR: non-voting board observer
  [/employee.(?:elected|representative)/i,      'Employee Representative'],  // NO/SE
  [/\bhead\b/,                                  'Senior Executive'],
  [/\bmanager\b/i,                              'Executive'],
  [/\bchief\b/i,                                'Senior Executive'],  // generic Chief title
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
  [/person\s+discharging\s+managerial\s+responsibilit/i, 'Senior Executive'],  // ESMA standard PDMR term
  [/\bPDMR\b/,                                  'Senior Executive'],  // ESMA acronym
  [/\bsenior\s+executive\b/i,                   'Senior Executive'],  // FSMA BE
  [/\bsenior\s+manager\b/i,                     'Senior Executive'],
  [/sonstige\s+f[uü]hrungsperson/i,             'Senior Executive'],   // DE: other person with managerial responsibilities
  [/persona\s+con\s+responsabilidad/i,          'Senior Executive'],   // ES
  [/member\s+of\s+(?:the\s+)?executive\s+(?:leadership|committee|team|management)/i, 'Senior Executive'],
  [/membre\s+du\s+comit[eé]\s+(?:ex[eé]cutif|de\s+direction)/i, 'Executive Committee Member'],  // FR

  // ── Korean (KR) ──────────────────────────────────────────────────────────────
  [/대표이사/,                                   'CEO'],              // KR: representative director = CEO
  [/최고경영자/,                                  'CEO'],              // KR: chief executive officer
  [/부회장/,                                     'Vice Chairman'],    // KR: vice chairman (before 회장)
  [/회장/,                                       'Chairman'],         // KR: chairman (유진그룹 회장 etc.)
  [/사장/,                                       'President'],        // KR: president
  [/부사장/,                                     'Vice President'],   // KR: vice president
  [/부행장/,                                     'Vice President'],   // KR: vice director (banking)
  [/전무이사/,                                   'Executive Director'], // KR: senior managing director
  [/상무이사/,                                   'Executive Director'], // KR: managing director
  [/전무/,                                       'Executive Director'], // KR: senior managing director (abbr.)
  [/상무보/,                                     'Executive Director'], // KR: assistant managing director
  [/상무/,                                       'Executive Director'], // KR: managing director (abbr.)
  [/이사회의장/,                                  'Chairman'],         // KR: board chairman
  [/사외이사/,                                   'Non-Executive Director'], // KR: outside director
  [/이사/,                                       'Board Member'],     // KR: director/board member
  [/감사/,                                       'Board Member'],     // KR: auditor (supervisory role)
  [/CFO|최고재무책임자/,                          'CFO'],              // KR
  [/COO|최고운영책임자/,                          'COO'],              // KR
  [/CTO|최고기술책임자/,                          'CTO'],              // KR
  [/주요주주/,                                   'Major Shareholder'], // KR: major shareholder
  [/총괄임원/,                                   'Executive'],        // KR: supervising executive (before 임원)
  [/임원/,                                       'Executive'],        // KR: executive/officer (generic)
  [/경영리더/,                                   'Senior Executive'], // KR: management leader
  [/그룹장/,                                     'Senior Executive'], // KR: group head
  [/사업부장/,                                   'Senior Executive'], // KR: division head
  [/본부장/,                                     'Senior Executive'], // KR: department head
  [/실장/,                                       'Senior Executive'], // KR: team/department head
  [/센터장/,                                     'Senior Executive'], // KR: center head
  [/담당/,                                       'Executive'],        // KR: person in charge
  [/연구소장/,                                   'Director'],         // KR: research institute director
  [/연구위원/,                                   'Research Fellow'],  // KR: research fellow/associate
  [/공장장/,                                     'Director'],         // KR: factory/plant director
  [/사업고문/,                                   'Advisor'],          // KR: business advisor

  // ── Polish (PL) ──────────────────────────────────────────────────────────────
  [/wiceprezes[a]?\s+zarz/i,                  'Vice President'],    // PL: Wiceprezes(a) Zarządu (BEFORE prezes)
  [/\bprezes[a]?\s+zarz/i,                    'CEO'],               // PL: Prezes(a) Zarządu (\b prevents matching wiceprezes)
  [/czł?onk[a]?\s+zarz/i,                    'Executive Director'],// PL: Członek/Członka Zarządu
  [/dyrektor\s+(?:generaln|wykonawcz)/i,      'CEO'],               // PL: Dyrektor Generalny/Wykonawczy
  [/dyrektor\s+finansow/i,                    'CFO'],               // PL: Dyrektor Finansowy
  [/dyrektor\s+(?:zarz[aą]dzaj|ds\.)/i,       'Executive Director'],// PL: Dyrektor Zarządzający
  [/przewodnicz[aą]cy?\s+rady\s+nadzor/i,    'Chairman'],          // PL: Przewodniczący Rady Nadzorczej
  [/czł?onk[a]?\s+rady\s+nadzor/i,           'Board Member'],      // PL: Członek Rady Nadzorczej
  [/rady\s+nadzorcz/i,                        'Board Member'],      // PL: catch-all Rada Nadzorcza
  [/zarz[aą]d\b/i,                            'Board Member'],      // PL: catch-all Zarząd

  // ── General Secretary / Secretary General ────────────────────────────────────
  [/secretar(?:y|io)\s+general/i,               'General Secretary'],
  [/secr[eé]taire\s+g[eé]n[eé]ral/i,           'General Secretary'],  // FR

  // ── Norwegian roles ──────────────────────────────────────────────────────────
  [/styreleder/i,                               'Chairman'],           // NO
  [/styremedlem/i,                              'Board Member'],       // NO
  [/daglig\s+leder/i,                           'CEO'],                // NO
  [/\bfinanssjef\b/i,                           'CFO'],                // NO

  // ── Italian roles (supplemental) ─────────────────────────────────────────────
  [/consigliere\s+(?:di\s+)?amministrazione/i,  'Board Member'],       // IT
  [/direttore\s+generale/i,                     'CEO'],                // IT
  [/consigliere\s+indipendente/i,               'Independent Director'], // IT
  [/\bsindaco\b/i,                              'Auditor'],            // IT statutory auditor
  [/\bdirigente\b/i,                            'Executive'],          // IT
  [/\bprocuratore\b/i,                          'Attorney'],           // IT
  [/persona\s+rilevante/i,                      'Related Party'],      // IT closely associated
  [/\bpresidente\b/i,                           'Chairman'],           // IT/ES/PT standalone

  // ── Spanish roles (supplemental) ─────────────────────────────────────────────
  [/alta\s+direcci[oó]n/i,                      'Senior Management'],  // ES
  [/\bdirectivo\b/i,                            'Executive'],          // ES
  [/\bsecretario\b/i,                           'Secretary'],          // ES

  // ── French roles (supplemental) ──────────────────────────────────────────────
  [/g[eé]rant(?:e)?\b/i,                        'Managing Director'],  // FR
  [/\bpr[eé]sident(?:e)?\b/i,                   'Chairman'],           // FR standalone
  [/personne\s+morale\s+li[eé]e/i,              'Closely Associated Entity'],   // FR
  [/personne\s+(?:physique\s+)?li[eé]e/i,       'Closely Associated Person'],   // FR

  // ── Dutch roles (supplemental) ────────────────────────────────────────────────
  [/\bbestuurder\b/i,                           'Executive Director'],  // NL

  // ── Related Party ────────────────────────────────────────────────────────────
  [/closely\s+associated/i,                     'Related Party'],
  [/nahe\s+stehende\s+person/i,                 'Related Party'],  // DE
  [/in\s+enger\s+beziehung/i,                   'Closely Related Person'],  // DE
  [/persona\s+estrechamente\s+vinculada/i,       'Closely Associated Person'],  // ES
  [/person\s+in\s+close/i,                      'Related Party'],
  [/\bPMA\b/,                                   'Related Party'],  // Person Discharging Managerial Responsibilities — related
  [/co[\s-]?founder/i,                          'Co-Founder'],
  [/co\s+fondateur/i,                           'Co-Founder'],     // FR
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
  // Treat placeholder values as null
  if (/^[-–—]+$/.test(trimmed) || /^n\/a$/i.test(trimmed)) return null;
  // For Korean text, strip internal spaces so "상 무" matches /상무/
  const testStr = /[\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]/.test(trimmed)
    ? trimmed.replace(/\s+/g, '')
    : trimmed;
  for (const [pattern, english] of ROLE_RULES) {
    if (pattern.test(testStr)) return english;
  }
  return trimmed;
}

module.exports = { translateRole };
