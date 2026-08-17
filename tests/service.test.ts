import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepo, type MemoryRepo } from '../lib/db/memoryRepo';
import {
  addSubscription,
  buildDashboard,
  getOrCreateProfile,
  linkElixia,
  mutateSubscription,
  openSecret,
  reindexProfile,
  runDueBookings,
  runReindex,
  ServiceError,
  unlinkElixia,
  updateSettings,
} from '../lib/service';
import { releasesInRange } from '../lib/planner';
import type { AppConfig } from '../lib/appConfig';
import type { Profile, Subscription } from '../lib/types';

/**
 * The application's behaviour without HTTP or a database: create a profile, link
 * a gym account, manage classes, let the cron book them.
 *
 * The in-memory repo reproduces the constraints the real schema enforces — the
 * duplicate-class unique index and cascade-on-delete — so these cover the same
 * ground the database would.
 */

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

let repo: MemoryRepo;
let config: AppConfig;
let nowMs: number;

function setNow(ms: number): void {
  nowMs = ms;
  vi.setSystemTime(ms);
}

/** A clock for the cron that advances instantly instead of really sleeping. */
const instantClock = () => ({
  now: () => nowMs,
  sleep: async (ms: number) => setNow(nowMs + ms),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  nowMs = Date.parse('2026-08-04T05:00:00Z'); // a Tuesday, 08:00 in Helsinki
  vi.setSystemTime(nowMs);

  repo = createMemoryRepo();
  config = {
    repo,
    encryptionKey: ENCRYPTION_KEY,
    dryRun: false,
    mock: true,
    defaultBookingWindowDays: 7,
    defaultTimeZone: 'Europe/Helsinki',
    ephemeralStore: true,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const BODYPUMP = {
  className: 'Bodypump',
  center: 'Tapiola',
  weekday: 'tuesday',
  startTime: '09:00',
  onFull: 'waitlist',
};

/** A profile with a working Elixia link. */
async function linkedProfile(userId = USER_ID, email = 'gym@example.com'): Promise<Profile> {
  const profile = await getOrCreateProfile(config, userId);
  return linkElixia(config, profile, email, 'correct-horse', nowMs);
}

function firstRelease(sub: Subscription, windowDays = 7): number {
  const release = releasesInRange(
    { ...sub, bookingWindowDays: windowDays },
    nowMs,
    nowMs + 21 * 86_400_000,
    { timeZone: 'Europe/Helsinki', bookingWindowDays: windowDays },
  )[0];
  if (!release) throw new Error('no release found for fixture');
  return release.releaseEpochMs;
}

describe('profiles', () => {
  it('creates a profile on first use with the configured defaults', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);

    expect(profile.id).toBe(USER_ID);
    expect(profile.bookingWindowDays).toBe(7);
    expect(profile.timeZone).toBe('Europe/Helsinki');
    expect(profile.elixiaStatus).toBe('unlinked');
  });

  it('returns the same profile on later calls rather than resetting it', async () => {
    const first = await getOrCreateProfile(config, USER_ID);
    await updateSettings(config, first, { bookingWindowDays: 14, timeZone: 'UTC' }, nowMs);

    const second = await getOrCreateProfile(config, USER_ID);
    expect(second.bookingWindowDays).toBe(14);
    expect(second.timeZone).toBe('UTC');
  });
});

describe('linking a gym account', () => {
  it('verifies the credentials before storing them', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);

    // The mock backend rejects a short password.
    await expect(linkElixia(config, profile, 'gym@example.com', 'x', nowMs)).rejects.toThrow(
      ServiceError,
    );

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaStatus).toBe('unlinked');
    expect(stored!.elixiaSecret).toBeUndefined();
  });

  it('requires both fields', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    await expect(linkElixia(config, profile, '', 'pw', nowMs)).rejects.toThrow(/required/);
    await expect(
      linkElixia(config, profile, 'gym@example.com', '', nowMs),
    ).rejects.toThrow(/required/);
  });

  it('stores the credentials encrypted, never in plaintext', async () => {
    // A database dump must be inert. This is the whole point of the seal.
    await linkedProfile();

    const dump = repo.dump();
    expect(dump).not.toContain('correct-horse');
    expect(dump).not.toContain('mock-access');
    expect(dump).not.toContain('mock-refresh');
  });

  it('keeps the password recoverable by the app so it can re-authenticate', async () => {
    // Deliberate: without it the bot dies the first time a session lapses.
    const profile = await linkedProfile();
    const secret = await openSecret(config, profile);

    expect(secret.password).toBe('correct-horse');
    expect(secret.tokens?.accessToken).toBeTruthy();
  });

  it('shows the linked address in the dashboard', async () => {
    const profile = await linkedProfile(USER_ID, 'someone@example.com');
    const view = await buildDashboard(config, profile, nowMs);

    expect(view.account.elixiaEmail).toBe('someone@example.com');
    expect(view.account.elixiaStatus).toBe('ok');
  });

  it('erases the stored credentials on unlink', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    await unlinkElixia(config, profile, nowMs);

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaSecret).toBeUndefined();
    expect(stored!.elixiaEmail).toBeUndefined();
    expect(stored!.elixiaStatus).toBe('unlinked');
    expect(repo.dump()).not.toContain('correct-horse');
  });

  it('cancels scheduled bookings on unlink', async () => {
    // Otherwise the cron would keep firing against a link that is gone.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).not.toHaveLength(0);

    await unlinkElixia(config, profile, nowMs);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).toHaveLength(0);
  });
});

describe('managing classes', () => {
  it('adds a class and reports when its booking opens', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    const view = await buildDashboard(config, profile, nowMs);
    expect(view.subscriptions).toHaveLength(1);
    // Class Tue 11 Aug 09:00 Helsinki opens 7 days earlier: 4 Aug 06:00Z.
    expect(view.subscriptions[0]!.nextReleaseAt).toBe('2026-08-04T06:00:00.000Z');
  });

  it.each([
    ['a missing class name', { ...BODYPUMP, className: '' }],
    ['a missing centre', { ...BODYPUMP, center: '  ' }],
    ['an invalid weekday', { ...BODYPUMP, weekday: 'funday' }],
    ['a malformed time', { ...BODYPUMP, startTime: '9am' }],
  ])('rejects %s', async (_label, payload) => {
    const profile = await linkedProfile();
    await expect(addSubscription(config, profile, payload, nowMs)).rejects.toThrow(ServiceError);
  });

  it('refuses the same class twice, case-insensitively', async () => {
    // A duplicate would race itself at T-0: two requests for one slot.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    await expect(addSubscription(config, profile, BODYPUMP, nowMs)).rejects.toThrow(
      /already added/,
    );
    await expect(
      addSubscription(config, profile, { ...BODYPUMP, className: 'bodypump' }, nowMs),
    ).rejects.toThrow(/already added/);

    expect(await repo.listSubscriptions(profile.id)).toHaveLength(1);
  });

  it('allows the same class on a different day or time', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    await addSubscription(config, profile, { ...BODYPUMP, weekday: 'thursday' }, nowMs);
    await addSubscription(config, profile, { ...BODYPUMP, startTime: '18:00' }, nowMs);

    expect(await repo.listSubscriptions(profile.id)).toHaveLength(3);
  });

  it('pauses, resumes and removes', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    await mutateSubscription(config, profile, sub.id, 'toggle', nowMs);
    expect((await repo.listSubscriptions(profile.id))[0]!.enabled).toBe(false);

    await mutateSubscription(config, profile, sub.id, 'toggle', nowMs);
    expect((await repo.listSubscriptions(profile.id))[0]!.enabled).toBe(true);

    await mutateSubscription(config, profile, sub.id, 'delete', nowMs);
    expect(await repo.listSubscriptions(profile.id)).toHaveLength(0);
  });

  it('404s on a class that does not exist', async () => {
    const profile = await linkedProfile();
    await expect(
      mutateSubscription(config, profile, 'nope', 'delete', nowMs),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('drops scheduled bookings when a class is removed', async () => {
    // Enforced by ON DELETE CASCADE in the schema, mirrored by the fake repo.
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).not.toHaveLength(0);

    await mutateSubscription(config, profile, sub.id, 'delete', nowMs);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).toHaveLength(0);
  });

  it('drops scheduled bookings when a class is paused', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    await mutateSubscription(config, profile, sub.id, 'toggle', nowMs);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).toHaveLength(0);
  });
});

describe('isolation between users', () => {
  it('does not show one user the other’s classes', async () => {
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    await addSubscription(config, alice, BODYPUMP, nowMs);

    expect((await buildDashboard(config, bob, nowMs)).subscriptions).toHaveLength(0);
  });

  it('does not let one user touch the other’s class', async () => {
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    const sub = await addSubscription(config, alice, BODYPUMP, nowMs);

    await expect(
      mutateSubscription(config, bob, sub.id, 'delete', nowMs),
    ).rejects.toMatchObject({ status: 404 });

    expect(await repo.listSubscriptions(alice.id)).toHaveLength(1);
  });

  it('lets two users book the same class independently', async () => {
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    const sub = await addSubscription(config, alice, BODYPUMP, nowMs);
    await addSubscription(config, bob, BODYPUMP, nowMs);

    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(2);
  });
});

describe('settings', () => {
  it('rejects an invalid timezone', async () => {
    const profile = await linkedProfile();
    await expect(
      updateSettings(config, profile, { bookingWindowDays: 7, timeZone: 'Europe/Helsinky' }, nowMs),
    ).rejects.toThrow(/timezone/i);
  });

  it('rejects a fractional booking window', async () => {
    const profile = await linkedProfile();
    await expect(
      updateSettings(config, profile, { bookingWindowDays: 7.5, timeZone: 'UTC' }, nowMs),
    ).rejects.toThrow(/whole number/);
  });

  it('reschedules when the tier changes, so the cron fires at the new times', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    const before = await repo.claimDue(0, nowMs + 30 * 86_400_000);
    await updateSettings(
      config,
      profile,
      { bookingWindowDays: 14, timeZone: 'Europe/Helsinki' },
      nowMs,
    );
    const after = await repo.claimDue(0, nowMs + 30 * 86_400_000);

    // Same release instants, but each now books a class a week further out.
    expect(after[0]!.classDate).not.toBe(before[0]!.classDate);
  });
});

describe('the booking tick', () => {
  it('books a class the user added', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(1);

    const history = await repo.listHistory(profile.id);
    expect(history[0]).toMatchObject({ outcome: 'booked', className: 'Bodypump' });
  });

  it('does nothing on a tick with nothing due', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    expect(await runDueBookings(config, nowMs + 3 * 3_600_000, instantClock())).toBe(0);
  });

  it('still fires when the tick arrives a minute late', async () => {
    // GitHub Actions schedules are queued, not punctual. Skipping the slot
    // would be strictly worse than trying immediately.
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);
    const release = firstRelease(sub);

    setNow(release + 55_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(1);
  });

  it('skips a user whose gym link has expired', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);
    await repo.upsertProfile({ ...profile, elixiaStatus: 'expired' });

    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(0);
  });

  it('marks the link expired and stops when the stored credentials stop working', async () => {
    // Loud, not silent: the user has to know booking has stopped.
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    // Corrupt the sealed record so opening it fails, as a wrong key would.
    await repo.upsertProfile({ ...profile, elixiaSecret: 'not-a-valid-sealed-blob' });

    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(0);
    expect((await repo.getProfile(profile.id))!.elixiaStatus).toBe('expired');
  });

  it('re-authenticates with the stored password when the token has expired', async () => {
    // The reason the password is kept at all.
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    // Far enough ahead that the mock's short-lived token has lapsed.
    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(1);
    expect((await repo.getProfile(profile.id))!.elixiaStatus).toBe('ok');
  });

  it('records a dry run as a dry run rather than a real booking', async () => {
    config.dryRun = true;
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    setNow(firstRelease(sub) - 30_000);
    await runDueBookings(config, nowMs, instantClock());

    expect((await repo.listHistory(profile.id))[0]!.dryRun).toBe(true);
  });

  it('takes a waitlist place when the class is full', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(
      config,
      profile,
      { ...BODYPUMP, className: 'Full House Spin' },
      nowMs,
    );

    setNow(firstRelease(sub) - 30_000);
    await runDueBookings(config, nowMs, instantClock());

    expect((await repo.listHistory(profile.id))[0]!.outcome).toBe('waitlisted');
  });

  it('clamps the retry budget to a host deadline instead of being cut off', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);
    const release = firstRelease(sub);

    setNow(release - 30_000);
    const handled = await runDueBookings(config, nowMs, {
      ...instantClock(),
      deadlineMs: release + 2_000,
    });

    expect(handled).toBe(1);
    expect(await repo.listHistory(profile.id)).toHaveLength(1);
  });
});

describe('the schedule', () => {
  it('is populated as soon as a class is added, without waiting for the nightly job', async () => {
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    const due = await repo.claimDue(0, nowMs + 30 * 86_400_000);
    expect(due.some((d) => d.subscriptionId === sub.id)).toBe(true);
  });

  it('reindexes every linked profile nightly', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    expect(await runReindex(config, nowMs)).toBeGreaterThan(0);
  });

  it('leaves nothing scheduled for a profile with no gym link', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    expect(await reindexProfile(config, profile, nowMs)).toBe(0);
  });

  it('prunes releases that are long past', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    setNow(nowMs + 30 * 86_400_000);
    await runReindex(config, nowMs);

    const stale = await repo.claimDue(0, nowMs - 2 * 86_400_000);
    expect(stale).toHaveLength(0);
  });
});
