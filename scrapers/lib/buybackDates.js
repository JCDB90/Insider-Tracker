'use strict';

/**
 * Shared buyback program date-range extraction — used by nordic-buybacks.js,
 * norway-buybacks.js, uk-buybacks.js, spain-buybacks.js, and
 * globenewswire-buybacks.js.
 *
 * ── Corrections made to the originally-proposed version of this file ───────
 * A first draft of this module was proposed with a literal ready-to-use
 * implementation. Testing it against real filings (not just the two
 * examples it shipped with) found three real bugs, fixed here:
 *
 * 1. TIMEZONE BUG: the proposed parseDate() returned `new Date(y, m-1, d)` —
 *    a LOCAL-TIME Date object. Anything downstream that later calls
 *    `.toISOString()` on it (a very natural thing to do to get a DB-ready
 *    date string) shifts the date by a day in any timezone behind UTC,
 *    silently corrupting every single date. This module returns plain
 *    'YYYY-MM-DD' strings only, matching how every other scraper in this
 *    project already stores dates — no Date-object round-trip, no timezone
 *    to get wrong.
 *
 * 2. MISSING YEAR ON THE FIRST DATE: every one of the proposed date
 *    sub-patterns required a 4-digit year on BOTH dates. Real filings very
 *    commonly only state the year once, on the later date — "running
 *    between 16 July and 20 October 2026" (SEB-A, confirmed live), "during
 *    the period 2 January to 31 December 2026" (Schouw & Co., confirmed
 *    live) — so the proposed function returned {null, null} for both of
 *    these already-fixed-once cases (see nordic-buybacks.js /
 *    norway-buybacks.js git history from the buyback-date-fixes session).
 *    Implementing the proposal as given would have been a REGRESSION.
 *    Fixed by making the year optional on the first date and inheriting it
 *    from the second, with a year-boundary check (a program stated as
 *    "16 December and 20 January 2027" belongs to the PRIOR year on its
 *    start side).
 *
 * 3. "UP TO AND INCLUDING" ISN'T ALWAYS IMMEDIATELY FOLLOWED BY THE DATE:
 *    the brief's own second example — "runs from 2 March 2026 up to and
 *    including no later than 31 December 2026" (confirmed live, Trifork) —
 *    has "no later than" wedged between "up to and including" and the end
 *    date. The proposed regex for that phrase requires the date
 *    immediately after "including", so it failed on the brief's OWN second
 *    example. Fixed by allowing an optional qualifier phrase there.
 */

// Merged month-name table across all languages this module handles. No
// cross-language collisions checked here mean two different words for the
// same calendar month coexisting (e.g. "maj"/"mei"/"mai" all = May) — never
// two DIFFERENT months sharing one word.
const MONTHS = {
  // English
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // Swedish
  januari: 1, februari: 2, mars: 3, maj: 5, juni: 6, juli: 7, augusti: 8, oktober: 10,
  // Norwegian / Danish
  januar: 1, februar: 2, mai: 5, desember: 12,
  // Dutch
  maart: 3, mei: 5, augustus: 8,
  // Finnish
  tammikuu: 1, helmikuu: 2, maaliskuu: 3, huhtikuu: 4, toukokuu: 5, kesäkuu: 6,
  heinäkuu: 7, elokuu: 8, syyskuu: 9, lokakuu: 10, marraskuu: 11, joulukuu: 12,
  // Spanish
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const MONTH_WORD = '[a-zæøåäöüé]+\\.?';

/**
 * Parse a single date string in any of the formats this module recognises.
 * Returns 'YYYY-MM-DD' or null. `yearHint`, if given, is used when the
 * string itself has no 4-digit year (see file header, point 2).
 */
function parseDateString(str, yearHint) {
  if (!str) return null;
  let s = str.trim().replace(/^(?:den\s+|el\s+)/i, ''); // Swedish "den 12 maj", Spanish "el 12"

  // ISO: 2026-05-12
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoOrNull(+m[1], +m[2], +m[3]);

  // Numeric with separators: 12/05/2026 or 12.05.2026 (day-month-year, the
  // European convention every market this module covers uses)
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) return isoOrNull(+m[3], +m[2], +m[1]);

  // "12 May 2026" / "12. mai 2026" / "12 mei 2026" / Spanish "12 de mayo de
  // 2026" (the "de" connectors are optional so the same pattern covers both)
  m = s.match(new RegExp(`^(\\d{1,2})\\.?\\s+(?:de\\s+)?(${MONTH_WORD})\\s+(?:de\\s+)?(\\d{4})$`, 'i'));
  if (m) {
    const mon = MONTHS[normalizeWord(m[2])];
    return mon ? isoOrNull(+m[3], mon, +m[1]) : null;
  }
  // Same, but no year present — use yearHint
  m = s.match(new RegExp(`^(\\d{1,2})\\.?\\s+(?:de\\s+)?(${MONTH_WORD})$`, 'i'));
  if (m && yearHint) {
    const mon = MONTHS[normalizeWord(m[2])];
    return mon ? isoOrNull(+yearHint, mon, +m[1]) : null;
  }

  // "May 12, 2026" (US ordering)
  m = s.match(new RegExp(`^(${MONTH_WORD})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i'));
  if (m) {
    const mon = MONTHS[normalizeWord(m[1])];
    return mon ? isoOrNull(+m[3], mon, +m[2]) : null;
  }

  return null;
}

function normalizeWord(w) {
  return w.toLowerCase().replace(/\.$/, '');
}

function isoOrNull(y, mo, d) {
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A single date "word", used inside the range patterns below — deliberately
// permissive (year optional) since which side needs the year-inheritance
// fallback varies by phrasing; parseDateString + the yearHint fallback in
// extractDateRange() sort out validity afterwards.
const DATE = `(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[.\\/]\\d{1,2}[.\\/]\\d{4}|(?:den\\s+|el\\s+)?\\d{1,2}\\.?\\s+(?:de\\s+)?${MONTH_WORD}(?:\\s+(?:de\\s+)?\\d{4})?|${MONTH_WORD}\\s+\\d{1,2},?\\s+\\d{4})`;

// Ordered most-specific → least-specific, same principle as this project's
// other pattern tables (lib/translate.js's ROLE_RULES) — a generic pattern
// checked before a specific one can swallow the specific one's match first.
const RANGE_PATTERNS = [
  // English: "runs from X up to and including [no later than] Y"
  new RegExp(`runn?(?:ing|s)?\\s+from\\s+${DATE}\\s+up\\s+to\\s+and\\s+including\\s+(?:no\\s+later\\s+than\\s+)?${DATE}`, 'i'),
  // English: "runs between X and Y" / "running between X and Y"
  new RegExp(`runn?(?:ing|s)?\\s+between\\s+${DATE}\\s+and\\s+${DATE}`, 'i'),
  // English: "runs from X to/until/through Y"
  new RegExp(`runn?(?:ing|s)?\\s+from\\s+${DATE}\\s+(?:to|until|through|till)\\s+${DATE}`, 'i'),
  // English: "commencing X and ending/expiring Y" / "starting X ... expiring Y"
  new RegExp(`(?:commenc(?:ing|es?)|start(?:ing|s)?)\\s+${DATE}\\s+(?:and\\s+)?(?:ending|expiring|until)\\s+${DATE}`, 'i'),
  // English: "period [from] X to/through Y"
  new RegExp(`period\\s+(?:from\\s+)?${DATE}\\s+(?:to|through|till)\\s+${DATE}`, 'i'),
  // Swedish: "från X till [och med] Y" / "löper från X till Y"
  new RegExp(`fr[aå]n\\s+${DATE}\\s+till\\s+(?:och\\s+med\\s+)?${DATE}`, 'i'),
  // Norwegian: "X til senest Y" (no "fra" prefix — e.g. "Tilbakekjøpstransjens
  // varighet: 23. juli til senest 26. oktober 2026", Equinor ASA, confirmed
  // live). Tried before the bare "fra X til Y" pattern below since "til
  // senest" (until at the latest) unambiguously marks the PROGRAM's own
  // duration, whereas bare "fra...til..." also matches weekly execution
  // windows (see the exclusion note on extractDateRange()).
  new RegExp(`${DATE}\\s+til\\s+senest\\s+${DATE}`, 'i'),
  // Norwegian/Danish: "fra X til [og med] Y" / "perioden [fra] X til Y"
  new RegExp(`fra\\s+${DATE}\\s+til\\s+(?:og\\s+med\\s+)?${DATE}`, 'i'),
  // Dutch: "van X tot [en met] Y"
  new RegExp(`van\\s+${DATE}\\s+tot\\s+(?:en\\s+met\\s+)?${DATE}`, 'i'),
  // Dutch/English AFM filings: "from X up to and including Y" already covered above.
  // Spanish: "desde [el] X hasta [el] Y" / "del X al Y"
  new RegExp(`desde\\s+(?:el\\s+)?${DATE}\\s+hasta\\s+(?:el\\s+)?${DATE}`, 'i'),
  new RegExp(`del\\s+${DATE}\\s+al\\s+${DATE}`, 'i'),
  // Generic fallback: "between X and Y" (no "run(s/ning)" prefix — kept last
  // since it's the most likely to false-match unrelated text; callers that
  // also need a SEPARATE, narrower "between A and B" match for something
  // else, e.g. an execution-window date, should run their own check against
  // the text with this match's range already stripped — see matchIndex/
  // matchLength below).
  new RegExp(`between\\s+${DATE}\\s+and\\s+${DATE}`, 'i'),
];

/**
 * Extract a buyback program's start/end date range from free text.
 * Returns { start, end, matchIndex, matchLength } — start/end are
 * 'YYYY-MM-DD' strings or null; matchIndex/matchLength describe the matched
 * substring's position in `text` (or null if nothing matched), so callers
 * can strip it out before running their own separate execution-date search
 * on the same text without double-matching the same sentence (confirmed
 * necessary live: SEB-A's execution_date was wrongly overwritten with its
 * program's END date because a generic "between A and B" execution-date
 * regex re-matched the program-duration sentence this function already
 * consumed — see nordic-buybacks.js for that fix, now generalised here).
 *
 * A match immediately preceded by "Accumulated"/"Ackumulerat"/"Akkumuleret"
 * is rejected — every Nordic weekly execution report uses some form of
 * "Accumulated until DATE" as a running-total table caption, which
 * otherwise false-matches as if it were the program's own end date
 * (confirmed live on Schouw & Co.'s filings).
 *
 * A match immediately FOLLOWED by a purchase/execution verb ("has
 * purchased", "har kjøpt tilbake", etc.) is also rejected — weekly
 * execution reports commonly state a short reporting window as its own
 * "from X to Y" / "fra X til Y" sentence right before announcing that
 * week's trades ("Fra 27. juli til 31. juli 2026, har Equinor ASA kjøpt
 * tilbake totalt 660.000 egne aksjer...", confirmed live), which otherwise
 * false-matches as the program's own duration — the same failure mode as
 * "Accumulated until DATE" above, just shaped as a full range instead of a
 * single date.
 */
function extractDateRange(text) {
  if (!text) return { start: null, end: null, matchIndex: null, matchLength: null };
  const t = text.replace(/\s+/g, ' ').trim();

  // Company names routinely sit between the verb's parts ("har Equinor ASA
  // kjøpt tilbake", confirmed live) — same reason the Dutch "heeft...gekocht"
  // branch already allows a gap.
  const EXEC_WINDOW_VERBS = /\b(?:has\s+purchased|har\s+.{0,40}?kj(?:øpt|øbt)|har\s+.{0,40}?köpt|heeft\s+.{0,40}?gekocht|ha\s+.{0,40}?comprado|bought\s+back|has\s+bought\s+back)\b/i;

  for (const pattern of RANGE_PATTERNS) {
    const m = t.match(pattern);
    if (!m) continue;

    const precedingText = t.slice(Math.max(0, m.index - 20), m.index).trim();
    if (/(?:accumulated|ackumulerat|akkumuleret)$/i.test(precedingText)) continue;

    // Capped at the end of the CURRENT sentence — a real program-duration
    // match is often immediately followed by an unrelated exec-window
    // sentence a few words later (confirmed live: Equinor's "til senest"
    // program match is followed a sentence later by "Fra 27. juli til 31.
    // juli 2026, har Equinor ASA kjøpt..."), and a raw fixed-width lookahead
    // would wrongly reject the correct match just because that other
    // sentence's verb happened to fall within the window.
    const restOfText = t.slice(m.index + m[0].length, m.index + m[0].length + 100);
    const sentenceEnd = restOfText.indexOf('.');
    const followingText = sentenceEnd >= 0 ? restOfText.slice(0, sentenceEnd) : restOfText;
    if (EXEC_WINDOW_VERBS.test(followingText)) continue;

    const endStr = m[2].trim();
    const end = parseDateString(endStr);
    if (!end) continue;

    let startStr = m[1].trim();
    let start = parseDateString(startStr, end.slice(0, 4));
    // Year-boundary program ("16 December and 20 January 2027") — the
    // inherited year would land the start AFTER the end; it actually
    // belongs to the prior year.
    if (start && start > end) {
      start = parseDateString(startStr, String(Number(end.slice(0, 4)) - 1));
    }
    if (!start) continue;

    return { start, end, matchIndex: m.index, matchLength: m[0].length };
  }

  return { start: null, end: null, matchIndex: null, matchLength: null };
}

module.exports = { extractDateRange, parseDateString };
