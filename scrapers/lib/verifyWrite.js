/**
 * Write verification for Supabase writes.
 *
 * An UPDATE that RLS denies does not error — PostgREST just reports success
 * with 0 rows affected. That is how flag-signals/score-insiders/track-
 * performance silently wrote nothing for ~3 months after migration 020 blocked
 * anon writes (2026-08-12) while they still used the anon key. Every write
 * whose row count we know in advance should chain .select('id') and pass the
 * result here, so a blocked write aborts the run instead of "succeeding".
 */

class WriteBlockedError extends Error {
  constructor(message) { super(message); this.name = 'WriteBlockedError'; }
}

/**
 * @param {{data: any[]|null, error: any}} res  result of a write chained with .select('id')
 * @param {number} expected  rows the write should have touched
 * @param {string} label     context for the error message
 * @returns {number|null} rows written, or null on an ordinary DB error (caller handles `res.error`)
 * @throws {WriteBlockedError} on an RLS denial or fewer rows written than expected
 */
function assertWritten(res, expected, label) {
  const { data, error } = res;
  if (error?.code === '42501') {
    throw new WriteBlockedError(`${label}: permission denied (${error.message}) — running with the anon key?`);
  }
  if (error) return null;
  const got = data?.length ?? 0;
  if (got < expected) {
    throw new WriteBlockedError(`${label}: wrote ${got}/${expected} rows with no error — write silently blocked (RLS / anon key?)`);
  }
  return got;
}

module.exports = { assertWritten, WriteBlockedError };
