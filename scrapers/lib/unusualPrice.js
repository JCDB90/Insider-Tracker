'use strict';

/**
 * Absolute (no-history-needed) unusual-price rule, safe to apply at scrape time.
 *
 * Only a free grant (price exactly 0) is unconditionally safe to flag without
 * any peer comparison. A previous version of this function also flagged any
 * price under 1 unit of the local currency, on the assumption that no real
 * penny stock trades that low — that assumption was wrong and caused real
 * false positives once this ran across more markets (commit f5ab8d3): KLEA
 * HOLDING (FR) trades ~€0.16–0.20 (confirmed against live Yahoo data, exact
 * match), Image Systems AB (SE) ~SEK 0.63–0.65, edyoutec AB (SE) ~SEK 0.16 —
 * all genuine Nordic/Euronext Growth micro-caps, not option exercises. A
 * sub-unit price is common for these markets and is not, on its own, evidence
 * of anything unusual — only a peer-relative comparison (see flag-signals.js's
 * median-based rules) can tell a real €0.17 stock apart from an option
 * exercised at a nominal €0.17 on a stock that really trades at €40.
 *
 * flag-signals.js re-derives is_unusual_price independently every day from
 * scratch (it never trusts a prior value — see that file's comments) and is
 * the only place with enough cross-company/cross-date history to apply the
 * relative rules safely. Setting the flag here too is just so a row already
 * looks right immediately after scraping, before that daily pass runs — it
 * does not need to be exhaustive.
 */
function isAbsoluteUnusualPrice(price) {
  return price === 0;
}

module.exports = { isAbsoluteUnusualPrice };
