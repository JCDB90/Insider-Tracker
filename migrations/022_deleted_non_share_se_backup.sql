-- Backup table for the 2026-11 Swedish non-equity cleanup (options, warrants,
-- subscription rights, swaps, bonds, convertibles, capital equity, synthetic
-- options mis-ingested as share transactions). Rows are copied here, with the
-- FI instrument type as reason, before being deleted from insider_transactions.
CREATE TABLE IF NOT EXISTS deleted_non_share_se_2026_11 (
  LIKE insider_transactions INCLUDING DEFAULTS,
  reason     text        NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deleted_non_share_se_2026_11 ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (bypasses RLS) can read/write.
