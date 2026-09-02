import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import { CALENDAR_TOKEN_PATTERN } from '@/lib/calendarFeed';
import { MockElixiaClient } from '@/lib/mock';
import { enableCalendarSync, disableCalendarSync, calendarFeedFor, linkElixia } from '@/lib/service';
import type { BookingBackend } from '@/lib/elixia';
import type { AppConfig } from '@/lib/appConfig';
import type { Profile } from '@/lib/types';

/**
 * Turning the calendar feed on and off, and resolving a feed token back to
 * its document — the service-level half of calendar sync. lib/calendarFeed.ts
 * covers what the document itself looks like; this covers who gets one, and
 * what a caller presenting a token is allowed to learn.
 */

const NOW = Date.UTC(2026, 8, 1, 12, 0);

const repo = createMemoryRepo();
const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const config = {
  repo,
  encryptionKey: ENCRYPTION_KEY,
  dryRun: false,
  mock: true,
  ephemeralStore: false,
} as AppConfig;

const configured: Profile = {
  id: 'alice',
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'none',
  configuredAtMs: NOW,
  elixiaStatus: 'ok',
};

beforeEach(async () => {
  await repo.upsertProfile(configured);
});

describe('enableCalendarSync', () => {
  it('mints a token the first time sync is turned on', async () => {
    const updated = await enableCalendarSync(config, configured);

    expect(updated.calendarSyncEnabled).toBe(true);
    expect(CALENDAR_TOKEN_PATTERN.test(updated.calendarFeedToken ?? '')).toBe(true);
  });

  it('keeps the same token on a second, ordinary enable', async () => {
    const first = await enableCalendarSync(config, configured);
    const second = await enableCalendarSync(config, first);

    expect(second.calendarFeedToken).toBe(first.calendarFeedToken);
  });

  it('gives the same token back after a disable and a re-enable', async () => {
    const first = await enableCalendarSync(config, configured);
    const off = await disableCalendarSync(config, first);
    const on = await enableCalendarSync(config, off);

    expect(on.calendarFeedToken).toBe(first.calendarFeedToken);
    expect(on.calendarSyncEnabled).toBe(true);
  });

  it('mints a fresh token when asked to regenerate', async () => {
    const first = await enableCalendarSync(config, configured);
    const rotated = await enableCalendarSync(config, first, { regenerate: true });

    expect(rotated.calendarFeedToken).not.toBe(first.calendarFeedToken);
    // The old link is dead, not merely superseded: the store only ever holds
    // one token, so a lookup against the old one finds nobody.
    expect(await repo.getProfileByCalendarToken(first.calendarFeedToken!)).toBeNull();
  });
});

describe('disableCalendarSync', () => {
  it('turns the feed off without forgetting the token', async () => {
    const on = await enableCalendarSync(config, configured);
    const off = await disableCalendarSync(config, on);

    expect(off.calendarSyncEnabled).toBe(false);
    expect(off.calendarFeedToken).toBe(on.calendarFeedToken);
  });
});

describe('calendarFeedFor', () => {
  it('serves the document for a token whose sync is on', async () => {
    const on = await enableCalendarSync(config, configured);

    const feed = await calendarFeedFor(config, on.calendarFeedToken!, NOW);

    expect(feed).not.toBeNull();
    expect(feed).toContain('BEGIN:VCALENDAR');
  });

  it('refuses a token nobody was ever given', async () => {
    expect(await calendarFeedFor(config, 'a'.repeat(64), NOW)).toBeNull();
  });

  it('refuses a malformed token without even asking the database', async () => {
    expect(await calendarFeedFor(config, 'not-a-real-token', NOW)).toBeNull();
  });

  it('refuses a real token once sync has been turned off', async () => {
    const on = await enableCalendarSync(config, configured);
    await disableCalendarSync(config, on);

    expect(await calendarFeedFor(config, on.calendarFeedToken!, NOW)).toBeNull();
  });

  it('refuses an account that never finished setup, even with a token in hand', async () => {
    // Unreachable in practice — `enableCalendarSync` only ever runs against an
    // already-loaded profile — but the feed route trusts nothing about the
    // account behind a token beyond what it reads back from the database.
    await repo.upsertProfile({ id: 'bob', elixiaStatus: 'unlinked' });
    const bob = await enableCalendarSync(config, (await repo.getProfile('bob'))!);

    expect(await calendarFeedFor(config, bob.calendarFeedToken!, NOW)).toBeNull();
  });

  it('drops a booking cancelled through Elixia on the very first fetch, without waiting for a nightly run', async () => {
    // The bug this pins: a calendar app's first fetch — the moment someone
    // subscribes, or re-subscribes after deleting and re-adding the calendar
    // on their device — has to be correct immediately. Waiting for
    // `runReindex` to get around to it means a freshly (re)subscribed
    // calendar can start out showing a class the user already cancelled.
    const linked = await linkElixia(config, configured, 'gym@example.com', 'correct-horse', NOW);
    const sub = await repo.createSubscription({
      userId: linked.id,
      className: 'Bodypump',
      center: 'Tapiola',
      weekday: 'tuesday',
      startTime: '09:00',
      priority: 1,
    });
    await repo.appendHistory('alice', {
      atMs: NOW,
      subscriptionId: sub.id,
      className: 'Bodypump',
      classDate: '2026-09-08',
      startTime: '09:00',
      outcome: 'booked',
      attempts: 1,
      firstAttemptOffsetMs: 0,
      dryRun: false,
      center: 'Tapiola',
    });

    const mock = new MockElixiaClient();
    const gym: BookingBackend = {
      login: (email, password, at) => mock.login(email, password, at),
      refresh: (tokens, at) => mock.refresh(tokens, at),
      listCenters: (tokens) => mock.listCenters(tokens),
      listClasses: (tokens, center) => mock.listClasses(tokens, center),
      resolveClassId: (tokens, s, date) => mock.resolveClassId(tokens, s, date),
      checkAvailability: (tokens, center, checks) => mock.checkAvailability(tokens, center, checks),
      checkBookedStatus: async (tokens, center, checks) => checks.map(() => 'not-booked'),
      book: (tokens, id) => mock.book(tokens, id),
    };
    const withBackend: AppConfig = { ...config, backend: gym };

    const on = await enableCalendarSync(withBackend, linked);
    const feed = await calendarFeedFor(withBackend, on.calendarFeedToken!, NOW);

    expect(feed).not.toContain('BEGIN:VEVENT');
    expect((await repo.listHistory('alice'))[0]?.cancelledAtMs).toBe(NOW);
  });

  it('drops an "old" booking too — one made before the centre was ever recorded on its row', async () => {
    // The bug actually reported in production: an account that had been
    // booking classes since before `center` was added to booking_history
    // found that *no* cancelled class ever left its calendar, on any day,
    // because every one of its rows lacked a stored centre and the check
    // skipped every such row outright. The subscription itself still names a
    // centre, and that has to be enough.
    const linked = await linkElixia(config, configured, 'gym@example.com', 'correct-horse', NOW);
    // A different class/day/time than the sibling test above — this file
    // shares one repo across its tests, and identical ones would collide on
    // the duplicate-subscription index.
    const sub = await repo.createSubscription({
      userId: linked.id,
      className: 'Yoga',
      center: 'Tapiola',
      weekday: 'monday',
      startTime: '17:00',
      priority: 1,
    });
    await repo.appendHistory('alice', {
      atMs: NOW,
      subscriptionId: sub.id,
      className: 'Yoga',
      classDate: '2026-09-07',
      startTime: '17:00',
      outcome: 'booked',
      attempts: 1,
      firstAttemptOffsetMs: 0,
      dryRun: false,
      // No `center` — exactly what a pre-existing row looks like.
    });

    const mock = new MockElixiaClient();
    const gym: BookingBackend = {
      login: (email, password, at) => mock.login(email, password, at),
      refresh: (tokens, at) => mock.refresh(tokens, at),
      listCenters: (tokens) => mock.listCenters(tokens),
      listClasses: (tokens, center) => mock.listClasses(tokens, center),
      resolveClassId: (tokens, s, date) => mock.resolveClassId(tokens, s, date),
      checkAvailability: (tokens, center, checks) => mock.checkAvailability(tokens, center, checks),
      checkBookedStatus: async (tokens, center, checks) => checks.map(() => 'not-booked'),
      book: (tokens, id) => mock.book(tokens, id),
    };
    const withBackend: AppConfig = { ...config, backend: gym };

    const on = await enableCalendarSync(withBackend, linked);
    const feed = await calendarFeedFor(withBackend, on.calendarFeedToken!, NOW);

    expect(feed).not.toContain('BEGIN:VEVENT');
    expect((await repo.listHistory('alice'))[0]?.cancelledAtMs).toBe(NOW);
  });
});
