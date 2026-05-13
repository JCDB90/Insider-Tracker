-- Add program_end date column to buyback_programs
-- This stores the official end date of the buyback authorization,
-- distinct from execution_date (when shares were actually bought).
-- Used by the frontend to determine if a program is still active.

ALTER TABLE buyback_programs
  ADD COLUMN IF NOT EXISTS program_end date;

CREATE INDEX IF NOT EXISTS buyback_programs_program_end_idx
  ON buyback_programs (program_end);
