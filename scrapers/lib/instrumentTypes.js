/**
 * Instrument-type classification for Finansinspektionen (SE) insider filings.
 * Values are FI's own English labels from the "Intrument type" column
 * (sic — including FI's "Subcription warrant" misspelling).
 */

// Not the issuer's equity: the price is an option premium / warrant price /
// bond nominal, not a share price (e.g. Latour's "Köpoption Latour B 2026/2030"
// incentive call options at SEK 19.90 beside B-shares at SEK 202). Scrapers
// skip these rows entirely.
const NON_EQUITY_INSTRUMENTS = new Set([
  'Option', 'Call option', 'Put option', 'Synthetic option', 'Warrant',
  'Subcription warrant', 'Subscription warrant', 'Subscription right/Unit right',
  'Swap', 'Future/Forward', 'Other derivative contracts',
  'Bond', 'Convertible', 'Capital equity', 'Redemption share',
]);

// Paid-subscribed shares/units from a share issue (BTA/BTU) and interim shares:
// real equity, but bought at the issue's subscription price rather than in the
// open market. Kept and stored with is_unusual_price = true so they stay
// visible but never feed conviction/cluster/repeat signals. flag-signals.js
// reads raw_data.instrument_type to keep that flag across its daily recompute.
const SUBSCRIPTION_INSTRUMENTS = new Set(['BTA', 'BTU', 'Interim share']);

module.exports = { NON_EQUITY_INSTRUMENTS, SUBSCRIPTION_INSTRUMENTS };
