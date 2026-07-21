'use strict';

/**
 * Absolute (no-history-needed) unusual-price rule, safe to apply at scrape time.
 *
 * A free grant (price 0) or a sub-unit price (under 1 unit of the local
 * currency) is essentially always an RSU vesting, option exercise, or
 * rights-issue subscription price — never a genuine open-market share price
 * in any market this project covers (even the cheapest real penny stocks
 * trade at several units, not fractions of one).
 *
 * flag-signals.js re-derives is_unusual_price independently every day from
 * scratch (it never trusts a prior value — see that file's comments) and
 * additionally catches same-day/multi-insider coordinated-price events using
 * full cross-company history that a single scrape run doesn't have. Setting
 * the flag here too is just so a row already looks right immediately after
 * scraping, before that daily pass runs — it does not need to be exhaustive.
 */
function isAbsoluteUnusualPrice(price) {
  return price != null && price >= 0 && price < 1;
}

module.exports = { isAbsoluteUnusualPrice };
