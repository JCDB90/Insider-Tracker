// Plan prices — edit frontend/src/pricing.json, never a hardcoded "€" amount.
// Static pages get the same values via scripts/sync-constants.cjs at build time.
import PRICES from './pricing.json';

export { PRICES };

// €12, €9.99, €119.88 — whole euros without decimals.
export const eur = n => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;

// Cheapest effective monthly price (Pro, billed annually): the "from" price.
export const FROM_PRICE = PRICES.pro.annualMonthly;

// Annual-billing saving vs month-to-month, in whole percent.
export const annualSavingPct = plan =>
  Math.round((1 - PRICES[plan].annualMonthly / PRICES[plan].monthly) * 100);
