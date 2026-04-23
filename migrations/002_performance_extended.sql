-- ─────────────────────────────────────────────────────────────────────────────
-- InsidersAtlas — Performance Tracking Extended (180d + 365d)
-- Run in: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Extend insider_performance with 6m and 1y columns
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS price_180d  DECIMAL;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS price_365d  DECIMAL;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS return_180d DECIMAL;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS return_365d DECIMAL;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS hit_rate_90d  BOOLEAN;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS hit_rate_180d BOOLEAN;
ALTER TABLE insider_performance ADD COLUMN IF NOT EXISTS hit_rate_365d BOOLEAN;

-- 2. Aggregated insider scorecard view
-- Groups by insider across all companies for leaderboard sorting.
-- HAVING COUNT(*) >= 2 filters out one-off noise.
CREATE OR REPLACE VIEW insider_scorecard AS
SELECT
  insider_name,
  -- Use the most recent company name for display
  (ARRAY_AGG(company ORDER BY transaction_date DESC))[1]   AS company,
  (ARRAY_AGG(ticker  ORDER BY transaction_date DESC))[1]   AS ticker,
  (ARRAY_AGG(country_code ORDER BY transaction_date DESC))[1] AS country_code,
  COUNT(*)                                                  AS total_buys,

  -- Success rates (% of mature trades that were profitable)
  ROUND(AVG(CASE WHEN hit_rate_30d  IS NOT NULL THEN CASE WHEN hit_rate_30d  THEN 1.0 ELSE 0.0 END END) * 100, 1) AS success_rate_30d,
  ROUND(AVG(CASE WHEN hit_rate_90d  IS NOT NULL THEN CASE WHEN hit_rate_90d  THEN 1.0 ELSE 0.0 END END) * 100, 1) AS success_rate_90d,
  ROUND(AVG(CASE WHEN hit_rate_180d IS NOT NULL THEN CASE WHEN hit_rate_180d THEN 1.0 ELSE 0.0 END END) * 100, 1) AS success_rate_180d,
  ROUND(AVG(CASE WHEN hit_rate_365d IS NOT NULL THEN CASE WHEN hit_rate_365d THEN 1.0 ELSE 0.0 END END) * 100, 1) AS success_rate_365d,

  -- Mature trade counts per horizon
  COUNT(hit_rate_30d)  AS mature_30d,
  COUNT(hit_rate_90d)  AS mature_90d,
  COUNT(hit_rate_180d) AS mature_180d,
  COUNT(hit_rate_365d) AS mature_365d,

  -- Average returns (as %)
  ROUND(AVG(return_30d)  * 100, 1) AS avg_return_30d,
  ROUND(AVG(return_90d)  * 100, 1) AS avg_return_90d,
  ROUND(AVG(return_180d) * 100, 1) AS avg_return_180d,
  ROUND(AVG(return_365d) * 100, 1) AS avg_return_365d,

  -- Best single trade return at 90d
  ROUND(MAX(return_90d) * 100, 1)  AS best_return_90d,

  MAX(transaction_date) AS last_transaction_date
FROM insider_performance
GROUP BY insider_name
HAVING COUNT(*) >= 2;
