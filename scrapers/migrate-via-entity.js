/**
 * Migration: add via_entity column to insider_transactions.
 *
 * Run this once in your Supabase SQL editor:
 *   https://supabase.com/dashboard/project/loqmxllfjvdwamwicoow/sql/new
 *
 * Or run: node scrapers/migrate-via-entity.js
 * (prints the SQL and exits — copy/paste into Supabase dashboard)
 */
'use strict';

const SQL = `
-- Add via_entity column (stores the corporate entity that filed on behalf of an individual PDMR)
ALTER TABLE insider_transactions
  ADD COLUMN IF NOT EXISTS via_entity TEXT;

-- Backfill: move obvious corporate entity names from insider_name → via_entity
-- (legal suffixes: AS, ASA, NV, BV, SA, SRL, Ltd, LLC, GmbH, AG, PLC, AB, SE, A/S, Oy, etc.)
UPDATE insider_transactions
SET
  via_entity   = insider_name,
  insider_name = 'Not disclosed'
WHERE
  via_entity IS NULL
  AND insider_name IS NOT NULL
  AND (
    insider_name ~* '\\y(A\\.?S\\.?A?\\.?|N\\.?V\\.?|B\\.?V\\.?|S\\.?R\\.?L\\.?|Ltd\\.?|LLC|GmbH|AG|Inc\\.?|PLC|AB|SE|ASA|A\\/S|Oy|KGaA|SARL|BVBA|SPRL)[.,)]*\\s*$'
    OR insider_name ~* '\\y(Holdings?|Investments?|Ventures?|Enterprises?|Family Office)\\y'
  );
`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  via_entity migration — run the following SQL in Supabase:');
console.log('  https://supabase.com/dashboard/project/loqmxllfjvdwamwicoow/sql/new');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(SQL);
