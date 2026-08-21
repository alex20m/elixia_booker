import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createNeonRepo } from '@/lib/db/neonRepo';
import { CLAIM_LEASE_MS, DuplicateSubscriptionError, type Repo } from '@/lib/db/repo';
import type { Sql, SqlRow } from '@/lib/db/sql';
import type { Profile } from '@/lib/types';

/**
 * The Postgres-backed repo, exercised against real Postgres.
 *
 * PGlite is the same engine compiled to WebAssembly, running the same
 * `db/migrations` the deployment does, so the constraints under test here — the
 * duplicate-class unique index, the delete cascades, `date` formatting — are
 * the production ones rather than a fake's imitation of them. That matters
 * most for the isolation checks: with row-level security gone (see the schema
 * header), the `user_id = $1` predicate in every statement is the only thing
 * keeping one user out of another's rows, and a test that fakes the database
 * cannot tell whether a predicate was actually sent.
 *
 * Neon itself is not reachable from a test run, and the wire protocol is the
 * same, so what is *not* covered here is the connection string plumbing in
 * lib/db/neon.ts.
 */

const ALICE = 'user_alice';
const BOB = 'user_bob';

let db: PGlite;
let repo: Repo;

const profile = (id: string, overrides: Partial<Profile> = {}): Profile => ({
  id,
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  elixiaStatus: 'unlinked',
  ...overrides,
});

const addClass = (userId: string, className: string, startTime = '09:00') =>
  repo.createSubscription({
    userId,
    className,
    center: 'Tapiola',
    weekday: 'monday',
    startTime,
    priority: 1,
  });

// Booting Postgres costs seconds, so it is booted once and emptied between
// tests. `truncate ... cascade` reaches every table through the foreign keys,
// which also means a table added to the schema without a link back to profiles
// would start leaking state between tests — a reason to keep the graph
// connected, not to switch to a per-test database.
beforeAll(async () => {
  db = new PGlite();

  // Built from db/migrations rather than from a schema dump, so every migration
  // is exercised by this whole file: one that leaves the schema different from
  // what the repo's SQL expects fails here, not in production. Applied the same
  // way node-pg-migrate applies them — in file order, whole file, no `down`.
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(name, dir), 'utf8'));
  }

  const sql: Sql = {
    query: async (text, params = []) => (await db.query(text, params)).rows as SqlRow[],
    transaction: async (statements) => {
      await db.transaction(async (tx) => {
        for (const statement of statements) await tx.query(statement.text, statement.params ?? []);
      });
    },
  };

  repo = createNeonRepo(sql);
});

beforeEach(async () => {
  await db.exec('truncate table public.profiles cascade');
  await repo.upsertProfile(profile(ALICE));
  await repo.upsertProfile(profile(BOB));
});

afterAll(async () => {
  await db.close();
});

describe('profiles', () => {
  it('round-trips every field a linked profile carries', async () => {
    await repo.upsertProfile(
      profile(ALICE, {
        bookingWindowDays: 14,
        timeZone: 'Europe/Stockholm',
        telegramChatId: '12345',
        elixiaEmail: 'gym@example.com',
        elixiaSecret: 'sealed-blob',
        elixiaStatus: 'ok',
        elixiaCheckedAtMs: Date.UTC(2026, 3, 2, 8, 30),
      }),
    );

    expect(await repo.getProfile(ALICE)).toEqual({
      id: ALICE,
      bookingWindowDays: 14,
      timeZone: 'Europe/Stockholm',
      telegramChatId: '12345',
      elixiaEmail: 'gym@example.com',
      elixiaSecret: 'sealed-blob',
      elixiaStatus: 'ok',
      elixiaCheckedAtMs: Date.UTC(2026, 3, 2, 8, 30),
    });
  });

  it('erases the stored credentials when a profile is saved without them', async () => {
    await repo.upsertProfile(
      profile(ALICE, {
        elixiaEmail: 'gym@example.com',
        elixiaSecret: 'sealed-blob',
        elixiaStatus: 'ok',
      }),
    );

    // What unlinking does: same id, credentials dropped. An upsert that only
    // wrote the columns it was given would silently leave the password behind.
    await repo.upsertProfile(profile(ALICE, { elixiaStatus: 'unlinked' }));

    const stored = await repo.getProfile(ALICE);
    expect(stored?.elixiaSecret).toBeUndefined();
    expect(stored?.elixiaEmail).toBeUndefined();
    expect(stored?.elixiaStatus).toBe('unlinked');
  });

  it('returns null for a user with no profile yet', async () => {
    expect(await repo.getProfile('user_nobody')).toBeNull();
  });

  it('lists only profiles with a usable Elixia link', async () => {
    await repo.upsertProfile(profile(ALICE, { elixiaStatus: 'ok' }));
    await repo.upsertProfile(profile(BOB, { elixiaStatus: 'expired' }));

    expect((await repo.listLinkedProfiles()).map((p) => p.id)).toEqual([ALICE]);
  });
});

describe('subscriptions', () => {
  it('rejects the same class twice, whatever the casing', async () => {
    await addClass(ALICE, 'Bodypump');

    await expect(
      repo.createSubscription({
        userId: ALICE,
        className: 'bodypump',
        center: 'tapiola',
        weekday: 'monday',
        startTime: '09:00',
        priority: 2,
      }),
    ).rejects.toBeInstanceOf(DuplicateSubscriptionError);

    expect(await repo.listSubscriptions(ALICE)).toHaveLength(1);
  });

  it('lets a different user add the same class', async () => {
    await addClass(ALICE, 'Bodypump');
    await addClass(BOB, 'Bodypump');

    expect(await repo.listSubscriptions(BOB)).toHaveLength(1);
  });

  it('lists a user their own classes, lowest priority first', async () => {
    const second = await repo.createSubscription({
      userId: ALICE,
      className: 'Yoga',
      center: 'Tapiola',
      weekday: 'tuesday',
      startTime: '18:00',
      priority: 2,
    });
    const first = await addClass(ALICE, 'Bodypump');
    await addClass(BOB, 'Spinning');

    expect((await repo.listSubscriptions(ALICE)).map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it('refuses to delete a class belonging to someone else', async () => {
    const bobs = await addClass(BOB, 'Bodypump');

    expect(await repo.deleteSubscription(ALICE, bobs.id)).toBe(false);
    expect(await repo.listSubscriptions(BOB)).toHaveLength(1);
  });

  it('refuses to pause a class belonging to someone else', async () => {
    const bobs = await addClass(BOB, 'Bodypump');

    expect(await repo.setSubscriptionEnabled(ALICE, bobs.id, false)).toBe(false);
    expect((await repo.listSubscriptions(BOB))[0]?.enabled).toBe(true);
  });

  it('reports not-found rather than failing when the id is not a uuid at all', async () => {
    // Reachable from the API as /api/subscriptions/<anything>; a raw Postgres
    // cast error here would be a 500 where the user deserves a 404.
    expect(await repo.deleteSubscription(ALICE, 'not-a-uuid')).toBe(false);
    expect(await repo.setSubscriptionEnabled(ALICE, 'not-a-uuid', false)).toBe(false);
  });

  it('drops the scheduled releases of a deleted class', async () => {
    const subscription = await addClass(ALICE, 'Bodypump');
    await repo.replaceDueEntries(ALICE, [
      {
        userId: ALICE,
        subscriptionId: subscription.id,
        releaseEpochMs: Date.UTC(2026, 3, 1, 5, 0),
        classEpochMs: Date.UTC(2026, 3, 8, 5, 0),
        classDate: '2026-04-08',
      },
    ]);

    await repo.deleteSubscription(ALICE, subscription.id);

    expect(await repo.claimDue(0, Date.UTC(2030, 0, 1))).toEqual([]);
  });
});

describe('due entries', () => {
  const entry = (userId: string, subscriptionId: string, releaseEpochMs: number) => ({
    userId,
    subscriptionId,
    releaseEpochMs,
    classEpochMs: releaseEpochMs + 7 * 24 * 60 * 60 * 1000,
    classDate: '2026-04-08',
  });

  it('replaces one schedule without touching another user’s', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const bobs = await addClass(BOB, 'Yoga');
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, Date.UTC(2026, 3, 1, 5, 0))]);
    await repo.replaceDueEntries(BOB, [entry(BOB, bobs.id, Date.UTC(2026, 3, 1, 6, 0))]);

    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, Date.UTC(2026, 3, 1, 7, 0))]);

    const all = await repo.claimDue(0, Date.UTC(2030, 0, 1));
    expect(all.map((e) => [e.userId, e.releaseEpochMs])).toEqual([
      [BOB, Date.UTC(2026, 3, 1, 6, 0)],
      [ALICE, Date.UTC(2026, 3, 1, 7, 0)],
    ]);
  });

  it('clears a schedule when the new one is empty', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, Date.UTC(2026, 3, 1, 5, 0))]);

    await repo.replaceDueEntries(ALICE, []);

    expect(await repo.claimDue(0, Date.UTC(2030, 0, 1))).toEqual([]);
  });

  it('keeps the class date as a plain calendar date', async () => {
    // Postgres `date` arrives as a JS Date at UTC midnight. Rendering that in a
    // zone behind UTC — or handing it to the planner — moves the class a day.
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.replaceDueEntries(ALICE, [
      { ...entry(ALICE, alices.id, Date.UTC(2026, 3, 1, 5, 0)), classDate: '2026-04-08' },
    ]);

    expect((await repo.claimDue(0, Date.UTC(2030, 0, 1)))[0]?.classDate).toBe('2026-04-08');
  });

  it('carries a release note through, and omits it when there is none', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const bobs = await addClass(BOB, 'Yoga');
    await repo.replaceDueEntries(ALICE, [
      { ...entry(ALICE, alices.id, Date.UTC(2026, 3, 1, 5, 0)), releaseNote: 'gap' as const },
    ]);
    await repo.replaceDueEntries(BOB, [entry(BOB, bobs.id, Date.UTC(2026, 3, 1, 6, 0))]);

    const [withNote, withoutNote] = await repo.claimDue(0, Date.UTC(2030, 0, 1));
    expect(withNote?.releaseNote).toBe('gap');
    expect(withoutNote && 'releaseNote' in withoutNote).toBe(false);
  });

  it('claims releases inside the window, including both edges, oldest first', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const from = Date.UTC(2026, 3, 1, 5, 0);
    const to = Date.UTC(2026, 3, 1, 5, 2);
    await repo.replaceDueEntries(ALICE, [
      entry(ALICE, alices.id, from - 1),
      entry(ALICE, alices.id, to),
      entry(ALICE, alices.id, from),
      entry(ALICE, alices.id, to + 1),
    ]);

    expect((await repo.claimDue(from, to)).map((e) => e.releaseEpochMs)).toEqual([from, to]);
  });

  it('claims a release only once, until the claim expires', async () => {
    // The watcher's own loop can ask "what's due right now" twice in quick
    // succession around the same release — once before firing it, once again
    // on the next iteration while it's still inside the claim window. The
    // second ask must get nothing, or the class gets booked twice.
    const alices = await addClass(ALICE, 'Bodypump');
    const release = Date.UTC(2026, 3, 1, 5, 0);
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, release)]);

    const claimedAt = Date.UTC(2026, 3, 1, 4, 59);
    const first = await repo.claimDue(release - 60_000, release + 60_000, claimedAt);
    expect(first.map((e) => e.releaseEpochMs)).toEqual([release]);

    const secondCaller = await repo.claimDue(release - 60_000, release + 60_000, claimedAt + 1_000);
    expect(secondCaller).toEqual([]);
  });

  it('reclaims a release once its claim is old enough to be abandoned', async () => {
    // A caller that claimed a release and then crashed — a killed serverless
    // invocation, a network drop — must not take the release out of
    // circulation forever. It becomes reclaimable once its claim is older
    // than any invocation should legitimately still be running.
    const alices = await addClass(ALICE, 'Bodypump');
    const release = Date.UTC(2026, 3, 1, 5, 0);
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, release)]);

    const claimedAt = Date.UTC(2026, 3, 1, 4, 59);
    await repo.claimDue(release - 60_000, release + 60_000, claimedAt);

    const stillLeased = await repo.claimDue(
      release - 60_000,
      release + 60_000,
      claimedAt + CLAIM_LEASE_MS - 1,
    );
    expect(stillLeased).toEqual([]);

    const afterLeaseExpires = await repo.claimDue(
      release - 60_000,
      release + 60_000,
      claimedAt + CLAIM_LEASE_MS + 1,
    );
    expect(afterLeaseExpires.map((e) => e.releaseEpochMs)).toEqual([release]);
  });

  it('peeks the earliest unclaimed release without claiming it', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const sooner = Date.UTC(2026, 3, 1, 5, 0);
    const later = Date.UTC(2026, 3, 8, 5, 0);
    await repo.replaceDueEntries(ALICE, [
      entry(ALICE, alices.id, later),
      entry(ALICE, alices.id, sooner),
    ]);

    expect(await repo.peekNextRelease(0)).toBe(sooner);
    // Peeking must not have claimed it: it is still there to actually claim.
    expect((await repo.claimDue(sooner, sooner)).map((e) => e.releaseEpochMs)).toEqual([sooner]);
  });

  it('respects the floor, and reports nothing scheduled that far out', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const release = Date.UTC(2026, 3, 1, 5, 0);
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, release)]);

    expect(await repo.peekNextRelease(release + 1)).toBeNull();
  });

  it('peek skips a claimed release until its claim expires', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const release = Date.UTC(2026, 3, 1, 5, 0);
    await repo.replaceDueEntries(ALICE, [entry(ALICE, alices.id, release)]);

    const claimedAt = Date.UTC(2026, 3, 1, 4, 59);
    await repo.claimDue(release, release, claimedAt);

    expect(await repo.peekNextRelease(0, claimedAt + CLAIM_LEASE_MS - 1)).toBeNull();
    expect(await repo.peekNextRelease(0, claimedAt + CLAIM_LEASE_MS + 1)).toBe(release);
  });

  it('prunes only the releases older than the cutoff, and says how many', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const cutoff = Date.UTC(2026, 3, 1, 5, 0);
    await repo.replaceDueEntries(ALICE, [
      entry(ALICE, alices.id, cutoff - 1000),
      entry(ALICE, alices.id, cutoff),
      entry(ALICE, alices.id, cutoff + 1000),
    ]);

    expect(await repo.pruneDueEntries(cutoff)).toBe(1);
    expect((await repo.claimDue(0, Date.UTC(2030, 0, 1))).map((e) => e.releaseEpochMs)).toEqual([
      cutoff,
      cutoff + 1000,
    ]);
  });
});

describe('booking history', () => {
  const attempt = (atMs: number, subscriptionId: string | null, outcome = 'booked') => ({
    atMs,
    subscriptionId,
    className: 'Bodypump',
    classDate: '2026-04-08',
    startTime: '09:00',
    outcome: outcome as 'booked',
    attempts: 2,
    firstAttemptOffsetMs: -40,
    dryRun: false,
  });

  it('returns a user their own attempts, newest first', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    const bobs = await addClass(BOB, 'Yoga');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 2, 5, 0), alices.id, 'waitlisted'));
    await repo.appendHistory(BOB, attempt(Date.UTC(2026, 3, 3, 5, 0), bobs.id));

    const history = await repo.listHistory(ALICE);
    expect(history.map((h) => [h.atMs, h.outcome])).toEqual([
      [Date.UTC(2026, 3, 2, 5, 0), 'waitlisted'],
      [Date.UTC(2026, 3, 1, 5, 0), 'booked'],
    ]);
  });

  it('round-trips the details the UI shows', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, {
      ...attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id),
      detail: 'waitlist position 3',
      dryRun: true,
    });

    expect(await repo.listHistory(ALICE)).toEqual([
      {
        atMs: Date.UTC(2026, 3, 1, 5, 0),
        subscriptionId: alices.id,
        className: 'Bodypump',
        classDate: '2026-04-08',
        startTime: '09:00',
        outcome: 'booked',
        detail: 'waitlist position 3',
        attempts: 2,
        firstAttemptOffsetMs: -40,
        dryRun: true,
      },
    ]);
  });

  it('honours the limit', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    for (let day = 1; day <= 4; day++) {
      await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, day, 5, 0), alices.id));
    }

    expect(await repo.listHistory(ALICE, 2)).toHaveLength(2);
  });

  it('keeps the record of an attempt after its class is removed', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));

    await repo.deleteSubscription(ALICE, alices.id);

    const history = await repo.listHistory(ALICE);
    expect(history).toHaveLength(1);
    expect(history[0]?.subscriptionId).toBeNull();
  });
});
