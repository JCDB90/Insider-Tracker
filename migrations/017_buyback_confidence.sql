-- Add confidence column to buyback_programs.
--
-- Regulatory-filing sources (Oslo Newsweb, Nasdaq Nordic, FCA NSM, FSMA STORI)
-- carry official disclosure dates and are considered 'high' confidence.
-- Press-release sources (GlobeNewswire) report the same information voluntarily
-- and are considered 'medium' confidence — useful for program_start/max_value
-- context but not backed by a regulator's own record.
--
-- Existing rows are left NULL (all pre-date this column and are all from
-- regulatory sources; NULL is treated as 'high' by convention in the frontend,
-- not backfilled here since that's an assumption, not observed data).

ALTER TABLE buyback_programs
  ADD COLUMN IF NOT EXISTS confidence TEXT;
