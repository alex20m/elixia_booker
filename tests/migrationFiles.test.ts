import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Conventions db/migrations has to hold to, checked when a pull request is
 * opened rather than when a merge reaches production.
 *
 * node-pg-migrate enforces most of this itself — ordering, applying each file
 * once, the ledger — but only against a real database, which by then is the
 * production one. These are the mistakes that are cheap to make in a branch and
 * expensive to discover at the point of deploy.
 */

const dir = new URL('../db/migrations/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();

describe('migration files', () => {
  it('has migrations to apply', () => {
    // Guards the checks below from passing by having nothing to check.
    expect(files.length).toBeGreaterThan(0);
  });

  it('names every migration <0000>_<lower_snake_case>.sql', () => {
    // The four-digit prefix is what orders them, and node-pg-migrate records
    // the file name, so a rename after the fact reapplies the migration.
    for (const name of files) {
      expect(name, `${name} is misnamed`).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('gives every migration its own number', () => {
    // Two branches each adding "the next" migration is how this happens, and
    // git merges both files without complaint.
    const versions = files.map((name) => name.slice(0, 4));
    expect(versions).toEqual([...new Set(versions)]);
  });

  it('leaves transaction control to the migration runner', () => {
    // node-pg-migrate wraps the run in one transaction. A `begin` or `commit`
    // inside a migration splits that into pieces that can half-apply, and the
    // failure only shows up on the migration that fails.
    for (const name of files) {
      const sql = readFileSync(new URL(name, dir), 'utf8');
      const statements = sql.replace(/--[^\n]*/g, '');
      expect(statements, `${name} manages its own transaction`).not.toMatch(
        /(^|;)\s*(begin|commit|rollback)\b/i,
      );
    }
  });
});
