/**
 * `npm run migrate` — apply db/migrations to the database in `DATABASE_URL`.
 *
 * The migrating itself is node-pg-migrate's: it owns the ledger table, the
 * ordering, the apply-once bookkeeping, the advisory lock and the transaction
 * each migration runs in. What is here is only the configuration it needs and
 * the two things a CLI invocation would not give us — the environment files,
 * and an error message that says what to do about a missing connection string.
 *
 * Migrations are plain `.sql` files. With no `-- Up Migration` marker in them,
 * node-pg-migrate treats the whole file as the up migration and the migration
 * as irreversible, which is what this project wants: rolling a schema back on
 * a live database is a restore-from-branch decision, not a `down` script.
 */

import { config as loadEnvFiles } from 'dotenv';
import { runner } from 'node-pg-migrate';

// Next loads .env.local for `npm run dev`; a plain tsx script does not, and
// `vercel env pull` writes there — so without this, `npm run migrate` would
// report no DATABASE_URL while the file sits next to it.
// Existing variables win, which is what makes CI's exported ones authoritative.
loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

async function main(): Promise<void> {
  // The unpooled endpoint when Vercel has given us one: node-pg-migrate holds
  // a session-scoped advisory lock while it works, and a transaction-mode
  // pooler cannot promise the same session across statements.
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Locally: `npx vercel env pull .env.local`, then ' +
        '`npm run migrate`.',
    );
  }

  const applied = await runner({
    databaseUrl,
    dir: 'db/migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    // Loading `.sql` files needs saying: the default loader imports each file
    // as a module, which is right for `.ts` migrations and nonsense for these.
    migrationLoaderStrategies: [{ extensions: ['.sql'], loader: 'legacySql' }],
    // Refuse a migration numbered below one that has already run — the shape a
    // merge conflict takes when two branches each add the next file.
    checkOrder: true,
    // Queue behind a run that is already in flight rather than failing; two
    // merges landing together should serialise, not lose one.
    advisoryLockMode: 'wait',
  });

  console.log(
    applied.length === 0
      ? 'Database is up to date; no migrations to apply.'
      : `Applied ${applied.length} migration(s).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
