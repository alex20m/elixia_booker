import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  MigrationError,
  loadMigrations,
  runMigrations,
  type Migration,
  type MigrationClient,
} from '@/lib/db/migrations';

/**
 * The migration runner, exercised against real Postgres.
 *
 * PGlite is the same engine the deployment runs, compiled to WebAssembly, and
 * it speaks the same simple query protocol — which matters more here than
 * anywhere else in the suite, because the runner's atomicity does not come from
 * code it owns. It comes from Postgres treating a multi-statement script as one
 * implicit transaction, so a migration that fails halfway leaves neither its
 * tables nor its ledger row behind. A fake would have to imitate that, and
 * would imitate it as working.
 */

let db: PGlite;
let client: MigrationClient;
let tempDir: string;

beforeEach(async () => {
  db = new PGlite();
  client = {
    exec: async (script) => {
      await db.exec(script);
    },
    rows: async (text, params = []) => (await db.query(text, params)).rows as Record<string, unknown>[],
  };
});

afterEach(async () => {
  await db.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const migration = (name: string, sql: string): Migration => ({
  version: name.slice(0, 4),
  name,
  sql,
});

/** The tables that currently exist, so a test can ask what a run really did. */
async function tables(): Promise<string[]> {
  const rows = await client.rows(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  return rows.map((row) => String(row.table_name));
}

async function ledger(): Promise<string[]> {
  const rows = await client.rows('select name from public.schema_migrations order by version');
  return rows.map((row) => String(row.name));
}

describe('applying migrations', () => {
  it('applies pending migrations in version order, not the order it was handed them', async () => {
    // Deliberately out of order: 0002 depends on the table 0001 creates, so a
    // runner that trusted the array would fail rather than silently reorder.
    const applied = await runMigrations(client, [
      migration('0002_add_colour.sql', 'alter table public.widgets add column colour text;'),
      migration('0001_widgets.sql', 'create table public.widgets (id int primary key);'),
    ]);

    expect(applied).toEqual(['0001_widgets.sql', '0002_add_colour.sql']);

    const columns = await client.rows(
      "select column_name from information_schema.columns where table_name = 'widgets' order by column_name",
    );
    expect(columns.map((row) => String(row.column_name))).toEqual(['colour', 'id']);
  });

  it('records what it applied, so a second run does nothing', async () => {
    const migrations = [migration('0001_widgets.sql', 'create table public.widgets (id int primary key);')];

    await runMigrations(client, migrations);
    await client.exec("insert into public.widgets values (1)");

    // `create table` without `if not exists` would throw on a re-run, and the
    // row would be gone if the runner had recreated the table.
    expect(await runMigrations(client, migrations)).toEqual([]);
    expect(await client.rows('select id from public.widgets')).toEqual([{ id: 1 }]);
    expect(await ledger()).toEqual(['0001_widgets.sql']);
  });

  it('leaves nothing behind when a migration fails halfway through', async () => {
    await expect(
      runMigrations(client, [
        migration(
          '0001_broken.sql',
          `create table public.kept (id int primary key);
           create table public.kept (id int primary key);`,
        ),
      ]),
    ).rejects.toThrow();

    // The first statement succeeded before the duplicate failed. If the script
    // were not one transaction, `kept` would survive and the next attempt at
    // this migration would fail on a table it thought it had never created.
    expect(await tables()).not.toContain('kept');
    expect(await ledger()).toEqual([]);
  });

  it('stops at the first failure rather than applying later migrations', async () => {
    await expect(
      runMigrations(client, [
        migration('0001_ok.sql', 'create table public.first (id int primary key);'),
        migration('0002_broken.sql', 'create table public.first (id int primary key);'),
        migration('0003_later.sql', 'create table public.third (id int primary key);'),
      ]),
    ).rejects.toThrow();

    expect(await ledger()).toEqual(['0001_ok.sql']);
    expect(await tables()).not.toContain('third');
  });

  it('reports which migration failed', async () => {
    await expect(
      runMigrations(client, [migration('0001_broken.sql', 'this is not sql;')]),
    ).rejects.toThrow(/0001_broken\.sql/);
  });
});

describe('protecting migrations that already ran', () => {
  it('refuses to run when an applied migration has been edited since', async () => {
    const before = [migration('0001_widgets.sql', 'create table public.widgets (id int primary key);')];
    await runMigrations(client, before);

    const after = [
      migration('0001_widgets.sql', 'create table public.widgets (id int primary key, colour text);'),
      migration('0002_next.sql', 'create table public.gadgets (id int primary key);'),
    ];

    // Editing an applied migration means the database and the file no longer
    // agree, and no later migration can be trusted to have the schema it
    // expects — so the run stops before applying the pending one.
    await expect(runMigrations(client, after)).rejects.toThrow(MigrationError);
    await expect(runMigrations(client, after)).rejects.toThrow(/0001_widgets\.sql/);
    expect(await tables()).not.toContain('gadgets');
  });

  it('accepts an applied migration whose file is unchanged', async () => {
    const first = migration('0001_widgets.sql', 'create table public.widgets (id int primary key);');
    await runMigrations(client, [first]);

    const applied = await runMigrations(client, [
      first,
      migration('0002_gadgets.sql', 'create table public.gadgets (id int primary key);'),
    ]);

    expect(applied).toEqual(['0002_gadgets.sql']);
  });

  it('does not mind a migration missing from disk that the database has run', async () => {
    // A branch checked out at an older commit has fewer files than the database
    // has rows. That is normal, and not a reason to refuse to migrate.
    await runMigrations(client, [
      migration('0001_widgets.sql', 'create table public.widgets (id int primary key);'),
    ]);

    await expect(runMigrations(client, [])).resolves.toEqual([]);
  });
});

describe('rejecting migrations it cannot run safely', () => {
  it('rejects a file name that does not carry a four-digit version', async () => {
    await expect(
      runMigrations(client, [
        { version: 'init', name: 'init.sql', sql: 'create table public.widgets (id int);' },
      ]),
    ).rejects.toThrow(MigrationError);
  });

  it('rejects a file name outside the permitted characters', async () => {
    // The version and name are written into the ledger as literals, so anything
    // that could close a quote has to be refused before it gets there.
    await expect(
      runMigrations(client, [
        {
          version: '0001',
          name: "0001_x'); drop table public.schema_migrations; --.sql",
          sql: 'create table public.widgets (id int);',
        },
      ]),
    ).rejects.toThrow(MigrationError);
  });

  it('rejects two migrations sharing a version number', async () => {
    // Two people adding 0002 on separate branches is the common way this
    // happens, and applying only one of them would be silent data loss.
    await expect(
      runMigrations(client, [
        migration('0002_widgets.sql', 'create table public.widgets (id int primary key);'),
        migration('0002_gadgets.sql', 'create table public.gadgets (id int primary key);'),
      ]),
    ).rejects.toThrow(/0002/);

    expect(await tables()).not.toContain('widgets');
  });
});

describe('loading migrations from disk', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'migrations-'));
  });

  it('reads .sql files in version order and ignores everything else', async () => {
    await writeFile(join(tempDir, '0002_second.sql'), 'select 2;');
    await writeFile(join(tempDir, '0001_first.sql'), 'select 1;');
    await writeFile(join(tempDir, 'README.md'), 'not a migration');
    await writeFile(join(tempDir, '0003_third.sql.bak'), 'select 3;');

    const loaded = await loadMigrations(pathToFileURL(join(tempDir, '/')));

    expect(loaded.map((entry) => entry.name)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(loaded[0]?.sql).toBe('select 1;');
    expect(loaded[0]?.version).toBe('0001');
  });

  it('finds the repository’s own migrations and they build the schema the app queries', async () => {
    const loaded = await loadMigrations();
    expect(loaded.length).toBeGreaterThan(0);

    await runMigrations(client, loaded);

    // The four tables lib/db/neonRepo.ts writes to. A migration that dropped
    // one, or was never added to the directory, fails here.
    expect(await tables()).toEqual(
      expect.arrayContaining(['booking_history', 'due_entries', 'profiles', 'subscriptions']),
    );
  });
});
