import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import { CALENDAR_TOKEN_PATTERN } from '@/lib/calendarFeed';
import { enableCalendarSync, disableCalendarSync, calendarFeedFor } from '@/lib/service';
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
const config = { repo, encryptionKey: 'k', dryRun: false, mock: true, ephemeralStore: false } as AppConfig;

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
});
