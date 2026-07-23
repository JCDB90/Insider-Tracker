'use strict';
/**
 * Currency normalization shared by flag-signals.js and daily-health-check.js.
 *
 * Dual-listed stocks (e.g. SSAB on Stockholm in SEK and Helsinki in EUR) file
 * transactions in different currencies for the exact same underlying share.
 * Comparing raw price_per_share across currencies makes a normal-priced trade
 * in one currency look like a massive discount against peers priced in
 * another (SSAB's CFO buying at EUR 8.78 got flagged unusual against a SEK
 * ~96 peer median — same real price, ~11x apart only because SEK/EUR ≈ 11).
 * Approximate reference rates (ECB euro foreign exchange reference rates,
 * 2026-07-22) — only used to make peer comparisons commensurable; every
 * displayed/stored price_per_share and total_value keeps its original filed
 * currency untouched.
 *
 * Kept in one place deliberately: this table was previously duplicated and
 * found to be missing ZAR/CAD in one of the two copies — a currency present
 * in the live data silently falling through the `|| 1` fallback is a bug,
 * not a no-op, so there must be exactly one copy to update.
 */
const EUR_RATE = { // 1 unit of currency → EUR
  EUR: 1,
  SEK: 0.0903, NOK: 0.0914, DKK: 0.1338, GBP: 1.1718, CHF: 1.0790,
  PLN: 0.2310, KRW: 0.000592, USD: 0.8766, ZAR: 0.0532, CAD: 0.6222,
};

function toEUR(price, currency) {
  const rate = EUR_RATE[currency];
  return price * (rate != null ? rate : 1);
}

module.exports = { EUR_RATE, toEUR };
