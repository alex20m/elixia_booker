/**
 * The thin seam between the repo and whatever is actually speaking Postgres.
 *
 * The repo takes a function, not a driver. In production that function is
 * Neon's serverless driver over HTTPS; in tests it is PGlite, the same Postgres
 * compiled to WebAssembly. Keeping the surface to "text and parameters in, rows
 * out" is what lets the test suite run the real SQL — constraints, cascades and
 * all — without a network or a container.
 */

export type SqlRow = Record<string, unknown>;

export interface Statement {
  text: string;
  params?: unknown[];
}

export interface Sql {
  query(text: string, params?: unknown[]): Promise<SqlRow[]>;
  /**
   * Run several statements as one transaction.
   *
   * Needed because rewriting a user's schedule is a delete followed by an
   * insert, and half of that is worse than neither: a crash in between would
   * leave the account with nothing scheduled until the nightly reindex noticed.
   * It cannot be collapsed into a single data-modifying CTE either — the insert
   * would not see the delete's effect and would collide with the very rows it
   * is replacing.
   */
  transaction(statements: Statement[]): Promise<void>;
}

/** Postgres SQLSTATEs the repo reacts to rather than propagates. */
const UNIQUE_VIOLATION = '23505';
const INVALID_TEXT_REPRESENTATION = '22P02';

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : '';
}

/** A duplicate rejected by a unique index. */
export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === UNIQUE_VIOLATION;
}

/**
 * A value that could not be cast — in practice, a subscription id from the URL
 * that is not a uuid.
 *
 * Worth distinguishing: the row genuinely is not there, so the caller wants a
 * not-found, not a 500 describing a cast failure to someone who typed a bad
 * URL.
 */
export function isInvalidTextRepresentation(error: unknown): boolean {
  return sqlState(error) === INVALID_TEXT_REPRESENTATION;
}

/**
 * Milliseconds from whatever the driver decided a timestamp is.
 *
 * Drivers disagree: node-postgres and PGlite parse `timestamptz` into a `Date`,
 * while a driver configured to skip type parsing hands back the raw string.
 * Both are correct; the repo just needs one answer.
 */
export function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(String(value));
}
