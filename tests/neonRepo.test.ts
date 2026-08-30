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
        notifyChannel: 'telegram',
        notifyEmail: 'alerts@example.com',
        telegramChatId: '12345',
        elixiaEmail: 'gym@example.com',
        elixiaSecret: 'sealed-blob',
        elixiaStatus: 'ok',
        elixiaCheckedAtMs: Date.UTC(2026, 3, 2, 8, 30),
        defaultCenter: '740',
        configuredAtMs: Date.UTC(2026, 3, 1, 7, 0),
      }),
    );

    expect(await repo.getProfile(ALICE)).toEqual({
      id: ALICE,
      bookingWindowDays: 14,
      timeZone: 'Europe/Stockholm',
      notifyChannel: 'telegram',
      notifyEmail: 'alerts@example.com',
      telegramChatId: '12345',
      elixiaEmail: 'gym@example.com',
      elixiaSecret: 'sealed-blob',
      elixiaStatus: 'ok',
      elixiaCheckedAtMs: Date.UTC(2026, 3, 2, 8, 30),
      defaultCenter: '740',
      configuredAtMs: Date.UTC(2026, 3, 1, 7, 0),
    });
  });

  it('stores an account that has chosen nothing yet as having chosen nothing', async () => {
    // The columns lost their defaults so this state can exist in the database
    // rather than being dressed up as a membership tier and a city nobody
    // named. Reading it back has to preserve that: `num(null)` is 0 and
    // `str(null)` is the string "null", and either would sail past a check for
    // "has a value" — as a zero-day booking window, and a timezone no
    // formatter can resolve.
    await repo.upsertProfile({ id: BOB, elixiaStatus: 'unlinked' });

    expect(await repo.getProfile(BOB)).toEqual({ id: BOB, elixiaStatus: 'unlinked' });
  });

  it('lets an account that has finished setup be told apart from one that has not', async () => {
    await repo.upsertProfile({ id: BOB, elixiaStatus: 'unlinked' });
    expect((await repo.getProfile(BOB))?.configuredAtMs).toBeUndefined();

    await repo.upsertProfile({
      id: BOB,
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'none',
      elixiaStatus: 'unlinked',
      configuredAtMs: Date.UTC(2026, 3, 1, 7, 0),
    });

    expect((await repo.getProfile(BOB))?.configuredAtMs).toBe(Date.UTC(2026, 3, 1, 7, 0));
  });

  it('remembers which centre a user last chose from, across sessions', async () => {
    // The whole point of the column: the choice has to survive the request
    // that made it, or the chooser starts from nothing every week.
    await repo.upsertProfile(profile(ALICE, { defaultCenter: '743' }));

    expect((await repo.getProfile(ALICE))?.defaultCenter).toBe('743');
  });

  it('has no remembered centre until one has been chosen', async () => {
    // Absent rather than empty: "never chosen" is what the chooser renders as
    // an unpicked centre, and '' would read as a club named nothing.
    expect((await repo.getProfile(ALICE))?.defaultCenter).toBeUndefined();
  });

  it('forgets the centre when a profile is saved without one', async () => {
    // Same reason every other column is written on conflict: a partial update
    // would leave a centre behind that the user has cleared.
    await repo.upsertProfile(profile(ALICE, { defaultCenter: '743' }));
    await repo.upsertProfile(profile(ALICE));

    expect((await repo.getProfile(ALICE))?.defaultCenter).toBeUndefined();
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

  it('round-trips calendar sync being on, with its token', async () => {
    await repo.upsertProfile(
      profile(ALICE, { calendarSyncEnabled: true, calendarFeedToken: 'a'.repeat(64) }),
    );

    const stored = await repo.getProfile(ALICE);
    expect(stored?.calendarSyncEnabled).toBe(true);
    expect(stored?.calendarFeedToken).toBe('a'.repeat(64));
  });

  it('leaves calendar sync out of a profile that never turned it on', async () => {
    await repo.upsertProfile(profile(ALICE));

    const stored = await repo.getProfile(ALICE);
    expect(stored?.calendarSyncEnabled).toBeUndefined();
    expect(stored?.calendarFeedToken).toBeUndefined();
  });

  it('finds a profile by its calendar feed token', async () => {
    await repo.upsertProfile(
      profile(ALICE, { calendarSyncEnabled: true, calendarFeedToken: 'b'.repeat(64) }),
    );
    await repo.upsertProfile(profile(BOB));

    expect((await repo.getProfileByCalendarToken('b'.repeat(64)))?.id).toBe(ALICE);
    expect(await repo.getProfileByCalendarToken('c'.repeat(64))).toBeNull();
  });

  it('lets two profiles both have no calendar feed token at once', async () => {
    // The unique index is partial (`where calendar_feed_token is not null`)
    // precisely so that two rows both storing null does not collide.
    await repo.upsertProfile(profile(ALICE));
    await expect(repo.upsertProfile(profile(BOB))).resolves.not.toThrow();
  });

  it('lists only profiles with a usable Elixia link', async () => {
    await repo.upsertProfile(profile(ALICE, { elixiaStatus: 'ok' }));
    await repo.upsertProfile(profile(BOB, { elixiaStatus: 'expired' }));

    expect((await repo.listLinkedProfiles()).map((p) => p.id)).toEqual([ALICE]);
  });

  it('deleting a profile removes its subscriptions, schedule and history, and nobody else\'s', async () => {
    await repo.upsertProfile(profile(ALICE, { elixiaEmail: 'gym@example.com', elixiaSecret: 'sealed-blob' }));
    const alices = await addClass(ALICE, 'Bodypump');
    const bobs = await addClass(BOB, 'Bodypump');
    await repo.replaceDueEntries(ALICE, [
      {
        userId: ALICE,
        subscriptionId: alices.id,
        releaseEpochMs: Date.UTC(2026, 3, 1, 5, 0),
        classEpochMs: Date.UTC(2026, 3, 8, 6, 0),
        classDate: '2026-04-08',
      },
    ]);
    await repo.replaceDueEntries(BOB, [
      {
        userId: BOB,
        subscriptionId: bobs.id,
        releaseEpochMs: Date.UTC(2026, 3, 1, 5, 0),
        classEpochMs: Date.UTC(2026, 3, 8, 6, 0),
        classDate: '2026-04-08',
      },
    ]);
    await repo.appendHistory(ALICE, {
      atMs: Date.UTC(2026, 3, 1, 5, 0),
      subscriptionId: alices.id,
      className: 'Bodypump',
      classDate: '2026-04-08',
      startTime: '09:00',
      outcome: 'booked',
      attempts: 1,
      firstAttemptOffsetMs: 0,
      dryRun: false,
    });

    await repo.deleteProfile(ALICE);

    expect(await repo.getProfile(ALICE)).toBeNull();
    expect(await repo.listSubscriptions(ALICE)).toEqual([]);
    expect(await repo.listHistory(ALICE)).toEqual([]);
    expect(await repo.claimDue(0, Date.UTC(2026, 4, 1))).toEqual([
      expect.objectContaining({ userId: BOB, subscriptionId: bobs.id }),
    ]);

    // Bob is untouched.
    expect(await repo.getProfile(BOB)).not.toBeNull();
    expect((await repo.listSubscriptions(BOB)).map((s) => s.id)).toEqual([bobs.id]);
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

  it('round-trips when a class was found missing from the schedule, and when it returns', async () => {
    // The column is read back as epoch milliseconds; a timestamptz that came
    // back as a string would put "Invalid Date" in the warning the owner sees.
    const subscription = await addClass(ALICE, 'Bodypump');
    const at = Date.parse('2026-08-18T03:00:00Z');

    expect(await repo.setSubscriptionUnlisted(ALICE, subscription.id, at)).toBe(true);
    expect((await repo.listSubscriptions(ALICE))[0]?.unlistedSinceMs).toBe(at);

    expect(await repo.setSubscriptionUnlisted(ALICE, subscription.id, null)).toBe(true);
    expect((await repo.listSubscriptions(ALICE))[0]?.unlistedSinceMs).toBeUndefined();
  });

  it('refuses to flag a class belonging to someone else', async () => {
    const bobs = await addClass(BOB, 'Bodypump');

    expect(await repo.setSubscriptionUnlisted(ALICE, bobs.id, Date.now())).toBe(false);
    expect((await repo.listSubscriptions(BOB))[0]?.unlistedSinceMs).toBeUndefined();
  });

  it('round-trips the date a class was confirmed missing, reading and writing a plain date string', async () => {
    // `date` columns are read through to_char (see this file's own header
    // comment) — a driver that parsed it into a Date at UTC midnight could
    // shift the calendar date under a non-UTC reader.
    const subscription = await addClass(ALICE, 'Bodypump');
    expect((await repo.listSubscriptions(ALICE))[0]?.unavailableClassDate).toBeUndefined();

    expect(
      await repo.setSubscriptionUnavailableDate(ALICE, subscription.id, '2026-08-25'),
    ).toBe(true);
    expect((await repo.listSubscriptions(ALICE))[0]?.unavailableClassDate).toBe('2026-08-25');

    expect(await repo.setSubscriptionUnavailableDate(ALICE, subscription.id, null)).toBe(true);
    expect((await repo.listSubscriptions(ALICE))[0]?.unavailableClassDate).toBeUndefined();
  });

  it('refuses to flag an unavailable date on a class belonging to someone else', async () => {
    const bobs = await addClass(BOB, 'Bodypump');

    expect(await repo.setSubscriptionUnavailableDate(ALICE, bobs.id, '2026-08-25')).toBe(false);
    expect((await repo.listSubscriptions(BOB))[0]?.unavailableClassDate).toBeUndefined();
  });

  it('round-trips who is running the class, and clears it when the name is null', async () => {
    const subscription = await addClass(ALICE, 'Bodypump');
    expect((await repo.listSubscriptions(ALICE))[0]?.instructorName).toBeUndefined();

    expect(await repo.setSubscriptionInstructor(ALICE, subscription.id, 'Maija Meikäläinen')).toBe(
      true,
    );
    expect((await repo.listSubscriptions(ALICE))[0]?.instructorName).toBe('Maija Meikäläinen');

    expect(await repo.setSubscriptionInstructor(ALICE, subscription.id, null)).toBe(true);
    expect((await repo.listSubscriptions(ALICE))[0]?.instructorName).toBeUndefined();
  });

  it('refuses to set an instructor on a class belonging to someone else', async () => {
    const bobs = await addClass(BOB, 'Bodypump');

    expect(await repo.setSubscriptionInstructor(ALICE, bobs.id, 'Someone Else')).toBe(false);
    expect((await repo.listSubscriptions(BOB))[0]?.instructorName).toBeUndefined();
  });

  it('reports not-found rather than failing when the id is not a uuid at all', async () => {
    // Reachable from the API as /api/subscriptions/<anything>; a raw Postgres
    // cast error here would be a 500 where the user deserves a 404.
    expect(await repo.deleteSubscription(ALICE, 'not-a-uuid')).toBe(false);
    expect(await repo.setSubscriptionEnabled(ALICE, 'not-a-uuid', false)).toBe(false);
    expect(await repo.setSubscriptionUnlisted(ALICE, 'not-a-uuid', Date.now())).toBe(false);
    expect(await repo.setSubscriptionUnavailableDate(ALICE, 'not-a-uuid', '2026-08-25')).toBe(false);
    expect(await repo.setSubscriptionInstructor(ALICE, 'not-a-uuid', 'Someone')).toBe(false);
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
    // QStash delivers at least once, so two ticks can ask "what's due right
    // now" for the same release inside the same claim window — a retried
    // delivery, or a duplicate message. The second ask must get nothing, or
    // the class gets booked twice.
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

describe('the indexes the schema carries', () => {
  /**
   * An index nobody reads still costs every write, and a *missing* one is
   * invisible until the table is large. Both mistakes are made in migrations,
   * where nothing else checks them — so the two facts the schema currently
   * rests on are pinned here, against the same real Postgres the repo's
   * queries run on.
   */
  const indexesOn = async (table: string): Promise<Map<string, string>> => {
    const rows = (
      await db.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'public' and tablename = $1`,
        [table],
      )
    ).rows;
    return new Map(rows.map((row) => [row.indexname, row.indexdef]));
  };

  it('looks a user\'s subscriptions up by the leftmost column of the unique index', async () => {
    // This is what makes a second index on (user_id) redundant, and it is a
    // property of the *unique* index rather than of anything in the app: put
    // another column first and every "my classes" read loses its index with
    // no test but this one noticing.
    const definition = (await indexesOn('subscriptions')).get('subscriptions_unique_class');
    expect(definition).toMatch(/\(user_id[,)]/);
  });

  it('carries no second index on subscriptions (user_id)', async () => {
    const names = [...(await indexesOn('subscriptions')).keys()].sort();
    expect(names).toEqual(['subscriptions_pkey', 'subscriptions_unique_class']);
  });

  it('keeps both release_at indexes on due_entries, which are not the same', async () => {
    // The partial one covers unclaimed rows; the plain one is what the
    // watcher's "unclaimed *or* expired claim" lookup falls back on. Dropping
    // the plain one as a lookalike turns that into a bitmap scan and a sort.
    const names = [...(await indexesOn('due_entries')).keys()];
    expect(names).toContain('due_entries_release');
    expect(names).toContain('due_entries_unclaimed_release');
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

  it('round-trips the centre a class was booked at, for the calendar feed', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, {
      ...attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id),
      center: 'Tapiola',
    });

    expect((await repo.listHistory(ALICE))[0]?.center).toBe('Tapiola');
  });

  it('leaves the centre out of a row written before the column existed', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));

    expect((await repo.listHistory(ALICE))[0]?.center).toBeUndefined();
  });

  it('marks a booking cancelled, round-tripping when it was', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));

    const marked = await repo.markHistoryCancelled(
      ALICE,
      alices.id,
      '2026-04-08',
      Date.UTC(2026, 3, 2, 6, 0),
    );

    expect(marked).toBe(true);
    expect((await repo.listHistory(ALICE))[0]?.cancelledAtMs).toBe(Date.UTC(2026, 3, 2, 6, 0));
  });

  it('leaves cancelledAtMs out until a booking is actually marked', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));

    expect((await repo.listHistory(ALICE))[0]?.cancelledAtMs).toBeUndefined();
  });

  it('does not mark a booking twice', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));
    await repo.markHistoryCancelled(ALICE, alices.id, '2026-04-08', Date.UTC(2026, 3, 2, 6, 0));

    const again = await repo.markHistoryCancelled(
      ALICE,
      alices.id,
      '2026-04-08',
      Date.UTC(2026, 3, 3, 6, 0),
    );

    expect(again).toBe(false);
    // The first timestamp stands — a second call finds nothing left to mark.
    expect((await repo.listHistory(ALICE))[0]?.cancelledAtMs).toBe(Date.UTC(2026, 3, 2, 6, 0));
  });

  it('does not mark a row belonging to a different subscription or date', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id));

    expect(await repo.markHistoryCancelled(ALICE, alices.id, '2026-04-15', Date.UTC(2026, 3, 2, 6, 0))).toBe(
      false,
    );
    expect(await repo.markHistoryCancelled(BOB, alices.id, '2026-04-08', Date.UTC(2026, 3, 2, 6, 0))).toBe(
      false,
    );
    expect((await repo.listHistory(ALICE))[0]?.cancelledAtMs).toBeUndefined();
  });

  it('does not mark an outcome that could never have held a place', async () => {
    const alices = await addClass(ALICE, 'Bodypump');
    await repo.appendHistory(ALICE, attempt(Date.UTC(2026, 3, 1, 5, 0), alices.id, 'too-early'));

    expect(
      await repo.markHistoryCancelled(ALICE, alices.id, '2026-04-08', Date.UTC(2026, 3, 2, 6, 0)),
    ).toBe(false);
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

/**
 * Pending Telegram links.
 *
 * These rows are what make the connect flow safe to expose on a public
 * endpoint, so the properties asserted here are the security ones: a token
 * works once, stops working when it expires, and only ever names the account
 * it was minted for.
 */
describe('telegram link tokens', () => {
  const HASH = 'f'.repeat(64);
  const OTHER = 'e'.repeat(64);
  const NOW = Date.UTC(2026, 5, 1, 12, 0);
  const SOON = NOW + 10 * 60_000;

  it('hands the waiting account back to whoever presents the token', async () => {
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBe(ALICE);
  });

  it('lets a token be claimed only once, so a leaked link cannot be reused', async () => {
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBe(ALICE);
    expect(await repo.claimTelegramLink(HASH, NOW)).toBeNull();
  });

  it('refuses a token that has expired, however valid it once was', async () => {
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, SOON + 1)).toBeNull();
  });

  it('refuses a token nobody minted', async () => {
    expect(await repo.claimTelegramLink(HASH, NOW)).toBeNull();
  });

  it('names the account the token was minted for, not some other one', async () => {
    await repo.createTelegramLink(BOB, HASH, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBe(BOB);
  });

  it('invalidates a user’s earlier link when they start connecting again', async () => {
    // Otherwise every abandoned attempt leaves a working token behind, and the
    // window in which one can be used stops being the ten minutes advertised.
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);
    await repo.createTelegramLink(ALICE, OTHER, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBeNull();
    expect(await repo.claimTelegramLink(OTHER, NOW)).toBe(ALICE);
  });

  it('sweeps links that expired long ago, so abandoned attempts do not pile up', async () => {
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);

    // Bob connecting much later is what triggers the sweep; Alice's token is
    // by then long dead and its row has no reason to survive.
    await repo.createTelegramLink(BOB, OTHER, SOON + 60 * 60_000, SOON + 1);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBeNull();
  });

  it('leaves another user’s pending link alone', async () => {
    await repo.createTelegramLink(ALICE, HASH, SOON, NOW);
    await repo.createTelegramLink(BOB, OTHER, SOON, NOW);

    expect(await repo.claimTelegramLink(HASH, NOW)).toBe(ALICE);
    expect(await repo.claimTelegramLink(OTHER, NOW)).toBe(BOB);
  });
});
