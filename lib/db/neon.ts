/**
 * The Neon connection.
 *
 * Neon's serverless driver talks to the database over HTTPS rather than a
 * TCP session, which is what makes it usable from a serverless function: there
 * is no pool to warm and no connection to leak when the invocation is frozen
 * between the booking tick and the next one.
 *
 * One consequence shapes the repo above it. Each `query()` is an independent
 * request with no session, so `BEGIN`/`COMMIT` cannot span calls — a
 * transaction has to be handed over as a batch, which is what `transaction()`
 * does here.
 */

import { neon } from '@neondatabase/serverless';
import type { Sql, SqlRow } from './sql';

/** Whether a database is configured at all. The UI says so plainly if not. */
export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

let cached: Sql | null = null;

/**
 * The shared client, or null when `DATABASE_URL` is unset.
 *
 * Null rather than a throw: with no database the app still has to render, and
 * explain what to set. `lib/appConfig.ts` falls back to the in-memory repo so
 * `npm run dev` works before Neon exists.
 */
export function neonSql(): Sql | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!cached) {
    const client = neon(connectionString);
    cached = {
      query: async (text, params = []) => (await client.query(text, params)) as SqlRow[],
      transaction: async (statements) => {
        await client.transaction((txn) =>
          statements.map((statement) => txn.query(statement.text, statement.params ?? [])),
        );
      },
    };
  }

  return cached;
}
