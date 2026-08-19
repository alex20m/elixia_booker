/**
 * `npm run migrate` — apply db/migrations to the database in `DATABASE_URL`.
 *
 * The runner itself lives in lib/db/migrations.ts and is tested against real
 * Postgres; everything here is the connection plumbing, which is not.
 *
 * It uses the driver's WebSocket client rather than the HTTP one the app uses.
 * The app's queries are single statements with parameters, which is exactly
 * what HTTP suits; a migration is a script of several statements that has to
 * commit or roll back as one, and that needs a session. The same reason rules
 * out the pooled endpoint for the advisory lock: a session-scoped lock is only
 * meaningful on a connection that stays put, so this connects unpooled when
 * Vercel has given us that URL.
 */

import { config as loadEnvFiles } from 'dotenv';
import { Client, neonConfig } from '@neondatabase/serverless';
import { loadMigrations, runMigrations, type MigrationClient } from '../lib/db/migrations';

// Next loads .env.local for `npm run dev`; a plain tsx script does not, and
// `vercel env pull` writes there — so without this, the command SETUP.md tells
// you to run would report no DATABASE_URL while the file sits next to it.
// Existing variables win, which is what makes CI's exported ones authoritative.
loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

// Node 22 has a global WebSocket and the driver picks it up on its own. This
// covers an older runtime, where it would otherwise fail with a message about
// `webSocketConstructor` that says nothing about what to install.
neonConfig.webSocketConstructor ??= globalThis.WebSocket;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Locally: `npx vercel env pull .env.local`, then ' +
        '`npm run migrate`. See SETUP.md.',
    );
  }

  const connection = new Client(connectionString);
  await connection.connect();

  const client: MigrationClient = {
    exec: async (script) => {
      // No parameters, so node-postgres sends this over the simple query
      // protocol — which is what makes a multi-statement script one implicit
      // transaction. Passing an empty array here would change that.
      await connection.query(script);
    },
    rows: async (text, params = []) => (await connection.query(text, params)).rows,
  };

  try {
    const applied = await runMigrations(client, await loadMigrations());

    if (applied.length === 0) {
      console.log('Database is up to date; no migrations to apply.');
    } else {
      console.log(`Applied ${applied.length} migration(s):`);
      for (const name of applied) console.log(`  ${name}`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
