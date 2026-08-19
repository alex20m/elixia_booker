/**
 * Ordered, apply-once schema migrations.
 *
 * The database is the one part of a deploy that cannot be rolled back. Vercel
 * can put yesterday's code back in seconds; it cannot put yesterday's columns
 * back, so the schema has to move forward in small, recorded steps rather than
 * by re-running a file and hoping `if not exists` covers it. `if not exists` is
 * exactly what stops covering it the moment a change is an `alter` rather than
 * a `create`: the re-run succeeds, does nothing, and says so in the same words
 * it uses when it worked.
 *
 * So each file in db/migrations is applied once, in version order, and written
 * into a ledger table in the same transaction that applies it. The atomicity is
 * Postgres's, not this module's: a multi-statement script sent as one query
 * runs inside an implicit transaction, so a migration that fails halfway leaves
 * neither its tables nor its ledger row behind. Two consequences follow, and
 * both are constraints on what a migration file may contain:
 *
 *  - **No transaction control.** A `begin` or `commit` inside a migration
 *    breaks the implicit transaction into pieces that can half-apply.
 *  - **Nothing that cannot run inside a transaction** — `create index
 *    concurrently`, chiefly. Such a change has to be applied by hand.
 *
 * The runner takes a client rather than opening one, because the tests run it
 * against PGlite — the same Postgres, compiled to WebAssembly — and prove the
 * rollback behaviour above on the real engine instead of trusting a fake to
 * imitate it. db/migrate.ts is the thin wrapper that supplies a Neon client.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** A migration file: its version, its file name, and its SQL. */
export interface Migration {
  version: string;
  name: string;
  sql: string;
}

/**
 * What the runner needs from a database.
 *
 * `exec` runs a script that may hold several statements and takes no
 * parameters — the simple query protocol, which is what makes the script one
 * transaction. `rows` is for the ledger reads, which do take parameters.
 */
export interface MigrationClient {
  exec(script: string): Promise<void>;
  rows(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/** A refusal to migrate: the files themselves are wrong, or disagree with the database. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * `0007_add_waitlist_flag.sql`.
 *
 * Enforced rather than merely conventional: the version and name are written
 * into the ledger as SQL literals (see `applyStatement`), and this is what
 * guarantees they cannot carry a quote. Anything outside it is refused before
 * a statement is built, not escaped.
 */
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * An arbitrary but fixed key for the advisory lock, so two runs — a merge that
 * lands while another is still deploying — queue instead of interleaving.
 * Session-scoped, so it is released even if the process dies with the
 * connection.
 */
const LOCK_KEY = 8_147_326_501;

const LEDGER = `
create table if not exists public.schema_migrations (
  version    text        primary key,
  name       text        not null,
  checksum   text        not null,
  applied_at timestamptz not null default now()
);
`;

/** Where the repository keeps its migrations. */
const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Read the migration files from disk, in version order.
 *
 * Ignores anything that is not a `.sql` file so an editor's backup or a README
 * sitting in the directory is not mistaken for schema.
 */
export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    entries.map(async (name) => ({
      version: name.slice(0, 4),
      name,
      sql: await readFile(new URL(name, dir), 'utf8'),
    })),
  );
}

/** Refuse anything whose name cannot be trusted, or that would apply ambiguously. */
function validate(migrations: Migration[]): void {
  const seen = new Map<string, string>();

  for (const migration of migrations) {
    const match = FILE_NAME.exec(migration.name);
    if (match === null) {
      throw new MigrationError(
        `Migration "${migration.name}" is not named <0000>_<lower_snake_case>.sql`,
      );
    }
    if (match[1] !== migration.version) {
      throw new MigrationError(
        `Migration "${migration.name}" claims version ${migration.version}`,
      );
    }

    const existing = seen.get(migration.version);
    if (existing !== undefined) {
      throw new MigrationError(
        `Migrations "${existing}" and "${migration.name}" share version ${migration.version}`,
      );
    }
    seen.set(migration.version, migration.name);
  }
}

/**
 * The script that applies one migration and records it, as a single unit.
 *
 * The ledger insert is appended to the migration's own SQL rather than sent
 * afterwards, because a crash in the gap between the two would leave a
 * migration applied and unrecorded — and the next run would try to apply it
 * again, against a schema that already has it.
 */
function applyStatement(migration: Migration): string {
  return `${migration.sql}
;
insert into public.schema_migrations (version, name, checksum)
values ('${migration.version}', '${migration.name}', '${checksum(migration.sql)}');`;
}

/**
 * Apply every migration the database has not yet seen, and return their names.
 *
 * Migrations already recorded are checked against their files first: if one has
 * been edited since it ran, the database and the directory no longer describe
 * the same schema, and nothing after it can be relied on — so the run stops
 * rather than applying a pending migration onto an unknown state. A migration
 * the *database* has but the directory does not is fine, and expected on an
 * older checkout.
 */
export async function runMigrations(
  client: MigrationClient,
  unordered: Migration[],
): Promise<string[]> {
  validate(unordered);

  // Sorted here rather than trusted from the caller: `loadMigrations` returns
  // them in order, but a caller that assembled the list itself would otherwise
  // decide the schema's history by accident.
  const migrations = [...unordered].sort((a, b) => a.version.localeCompare(b.version));

  await client.exec(LEDGER);
  await client.exec(`select pg_advisory_lock(${LOCK_KEY});`);

  try {
    const recorded = new Map(
      (await client.rows('select version, checksum from public.schema_migrations')).map((row) => [
        String(row.version),
        String(row.checksum),
      ]),
    );

    for (const migration of migrations) {
      const previous = recorded.get(migration.version);
      if (previous !== undefined && previous !== checksum(migration.sql)) {
        throw new MigrationError(
          `Migration "${migration.name}" has changed since it was applied. ` +
            'Add a new migration instead of editing one that has run.',
        );
      }
    }

    const applied: string[] = [];

    for (const migration of migrations.filter((entry) => !recorded.has(entry.version))) {
      try {
        await client.exec(applyStatement(migration));
      } catch (cause) {
        throw new Error(`Migration "${migration.name}" failed: ${(cause as Error).message}`, {
          cause,
        });
      }
      applied.push(migration.name);
    }

    return applied;
  } finally {
    await client.exec(`select pg_advisory_unlock(${LOCK_KEY});`);
  }
}
