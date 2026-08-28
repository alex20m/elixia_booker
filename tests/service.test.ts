import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepo, type MemoryRepo } from '../lib/db/memoryRepo';
import {
  addSubscription,
  buildDashboard,
  completeSetup,
  deleteAccount,
  requireConfigured,
  listCenters,
  listClasses,
  getOrCreateProfile,
  linkElixia,
  mutateSubscription,
  openSecret,
  centerDefaults,
  reindexProfile,
  runDueBookings,
  reviewListedClasses,
  runReindex,
  saveCenterDefaults,
  ServiceError,
  unlinkElixia,
  updateElixiaCredentials,
  updateSettings,
} from '../lib/service';
import { releasesInRange } from '../lib/planner';
import { MockElixiaClient } from '../lib/mock';
import type { BookingBackend } from '../lib/elixia';
import type { AppConfig } from '../lib/appConfig';
import type {
  AttemptOutcome,
  ConfiguredProfile,
  StoredTokens,
  Subscription,
} from '../lib/types';

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

/**
 * A clock for the cron that advances instantly instead of really sleeping.
 *
 * Virtual, not additive: `sleep` registers a wake-up instant and the clock
 * jumps to the earliest one still pending. Two bookings sleeping 30s side by
 * side both wake at +30s, where simply adding to the clock would push it to
 * +60s — making concurrent waits indistinguishable from consecutive ones,
 * which is the single distinction the fairness tests below are about.
 */
const instantClock = () => {
  const waiters: { at: number; wake: () => void }[] = [];
  let pumping = false;

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    while (waiters.length > 0) {
      // Let everything that can make progress at the current instant do so, so
      // the clock only moves when the run is genuinely waiting on it.
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));

      const earliest = Math.min(...waiters.map((w) => w.at));
      if (earliest > nowMs) setNow(earliest);

      const ready = waiters.filter((w) => w.at <= nowMs);
      for (const w of ready) waiters.splice(waiters.indexOf(w), 1);
      for (const w of ready) w.wake();
    }
    pumping = false;
  }

  return {
    now: () => nowMs,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        waiters.push({ at: nowMs + ms, wake });
        void pump();
      }),
  };
};

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
};

/**
 * The answers every fixture below is built on.
 *
 * Spelled out rather than defaulted, because the app has no defaults: a
 * profile is unconfigured until someone chooses, and nothing here — linking a
 * gym account included — is reachable before that.
 */
const SETUP = {
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'email',
  notifyEmail: 'me@example.com',
};

/** A profile through setup, with a working Elixia link. */
async function linkedProfile(
  userId = USER_ID,
  email = 'gym@example.com',
): Promise<ConfiguredProfile> {
  const profile = await getOrCreateProfile(config, userId);
  const configured = await completeSetup(config, profile, SETUP, nowMs);
  await linkElixia(config, configured, email, 'correct-horse', nowMs);
  return requireConfigured((await repo.getProfile(userId))!);
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
  it('creates a profile on first use with nothing chosen for the user', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);

    expect(profile.id).toBe(USER_ID);
    expect(profile.bookingWindowDays).toBeUndefined();
    expect(profile.timeZone).toBeUndefined();
    expect(profile.elixiaStatus).toBe('unlinked');
  });

  it('returns the same profile on later calls rather than resetting it', async () => {
    const first = await getOrCreateProfile(config, USER_ID);
    const configured = await completeSetup(config, first, SETUP, nowMs);
    await updateSettings(
      config,
      configured,
      { ...SETUP, bookingWindowDays: 14, timeZone: 'Europe/Stockholm' },
      nowMs,
    );

    const second = await getOrCreateProfile(config, USER_ID);
    expect(second.bookingWindowDays).toBe(14);
    expect(second.timeZone).toBe('Europe/Stockholm');
  });

  it('deleting an account wipes its profile, sealed Elixia secret and subscriptions, leaving other accounts alone', async () => {
    const alice = await linkedProfile(USER_ID);
    await addSubscription(config, alice, BODYPUMP, nowMs);
    const bob = await linkedProfile(OTHER_ID, 'other@example.com');
    await addSubscription(config, bob, BODYPUMP, nowMs);

    await deleteAccount(config, USER_ID);

    expect(await repo.getProfile(USER_ID)).toBeNull();
    expect(await repo.listSubscriptions(USER_ID)).toEqual([]);

    // Bob's account, elsewhere in the same table, is untouched.
    expect(await repo.getProfile(OTHER_ID)).not.toBeNull();
    expect((await repo.listSubscriptions(OTHER_ID)).length).toBe(1);
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

  it('refuses the link when Elixia could not be reached, without blaming the password', async () => {
    // An outage must not be reported as "wrong password" — the user would go
    // hunting for a typo in credentials that are perfectly good — and it must
    // not link the account either, since nothing was verified.
    // A working backend in every other respect — only reaching Elixia fails.
    const offline: BookingBackend = Object.assign(new MockElixiaClient(), {
      login: async (): Promise<StoredTokens> => {
        throw new Error('fetch failed');
      },
    });
    const profile = await getOrCreateProfile({ ...config, backend: offline }, USER_ID);

    const err = await linkElixia(
      { ...config, backend: offline },
      profile,
      'gym@example.com',
      'correct-horse',
      nowMs,
    ).catch((e: unknown) => e as ServiceError);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).status).toBe(502);
    expect((err as ServiceError).message).not.toMatch(/rejected/i);

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

/**
 * Correcting a mistyped address, or catching up with a password changed at the
 * gym, without going through unlink-and-link-again.
 *
 * That detour was never merely tedious: unlinking erases the schedule (see the
 * test above), so a member who used it to fix a typo silently lost every
 * booking the cron had queued and got it back only if the relink happened to
 * reindex in time. Editing keeps the same link, so there is nothing to lose.
 *
 * The two fields are deliberately asymmetric about what a blank means. The
 * form arrives with the current address filled in, so an empty email is
 * someone clearing a field and is refused; a password field is never
 * prefilled — there is nothing to prefill it with that would not put the
 * plaintext back on the wire — so an empty password means "leave it alone".
 */
describe('editing the linked credentials', () => {
  it('changes the stored address without asking for the password again', async () => {
    const profile = await linkedProfile();

    await updateElixiaCredentials(config, profile, { email: 'moved@example.com' }, nowMs);

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaEmail).toBe('moved@example.com');
    expect(stored!.elixiaStatus).toBe('ok');
    // The password the app re-authenticates with is the one already held.
    expect((await openSecret(config, stored!)).password).toBe('correct-horse');
  });

  it('changes the stored password while keeping the linked address', async () => {
    const profile = await linkedProfile();

    await updateElixiaCredentials(config, profile, { password: 'new-passphrase' }, nowMs);

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaEmail).toBe('gym@example.com');
    expect((await openSecret(config, stored!)).password).toBe('new-passphrase');
    expect(repo.dump()).not.toContain('new-passphrase');
  });

  it('leaves the working link untouched when Elixia refuses the new credentials', async () => {
    // The failure that makes this feature worth having: a typo must not cost
    // someone the link they already had.
    const profile = await linkedProfile();

    await expect(
      updateElixiaCredentials(config, profile, { password: 'x' }, nowMs),
    ).rejects.toThrow(ServiceError);

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaEmail).toBe('gym@example.com');
    expect(stored!.elixiaStatus).toBe('ok');
    expect((await openSecret(config, stored!)).password).toBe('correct-horse');
  });

  it('keeps the queued bookings, which unlinking and linking again would drop', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    await updateElixiaCredentials(config, profile, { email: 'moved@example.com' }, nowMs);

    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).not.toHaveLength(0);
  });

  it('refuses an address cleared to blank rather than silently keeping the old one', async () => {
    const profile = await linkedProfile();

    await expect(updateElixiaCredentials(config, profile, { email: '   ' }, nowMs)).rejects.toThrow(
      /required/,
    );
    expect((await repo.getProfile(USER_ID))!.elixiaEmail).toBe('gym@example.com');
  });

  it('refuses to edit an account that was never linked', async () => {
    // There is no password to fall back on, and nothing to correct. Refused
    // even when both fields are supplied — that is a first link, and linking
    // is what POST is for; letting an edit stand in for it would mean a UI
    // that reached for the wrong verb still worked, right up until it did not.
    const profile = await getOrCreateProfile(config, USER_ID);
    const configured = await completeSetup(config, profile, SETUP, nowMs);

    await expect(
      updateElixiaCredentials(config, configured, { email: 'gym@example.com' }, nowMs),
    ).rejects.toThrow(/No Elixia account linked/);
    await expect(
      updateElixiaCredentials(
        config,
        configured,
        { email: 'gym@example.com', password: 'correct-horse' },
        nowMs,
      ),
    ).rejects.toThrow(/No Elixia account linked/);

    expect((await repo.getProfile(USER_ID))!.elixiaStatus).toBe('unlinked');
  });

  it('brings a rejected link back to working without a relink', async () => {
    // What a member does after changing their password at the gym: the stored
    // one stopped working, the status went to expired, and the fix is one
    // field rather than typing the address in again.
    const profile = await linkedProfile();
    await repo.upsertProfile({ ...profile, elixiaStatus: 'expired' });

    await updateElixiaCredentials(
      config,
      requireConfigured((await repo.getProfile(USER_ID))!),
      { password: 'new-passphrase' },
      nowMs,
    );

    const stored = await repo.getProfile(USER_ID);
    expect(stored!.elixiaStatus).toBe('ok');
    expect(stored!.elixiaEmail).toBe('gym@example.com');
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

  it('refuses a class that is not on the centre\'s schedule', async () => {
    // The whole reason the chooser exists: a class nobody teaches can never be
    // resolved at T-0, so it would sit in the list booking nothing, silently.
    const profile = await linkedProfile();

    await expect(
      addSubscription(config, profile, { ...BODYPUMP, startTime: '06:00' }, nowMs),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      addSubscription(config, profile, { ...BODYPUMP, className: 'Underwater Basketry' }, nowMs),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      addSubscription(config, profile, { ...BODYPUMP, weekday: 'sunday' }, nowMs),
    ).rejects.toMatchObject({ status: 400 });

    expect(await repo.listSubscriptions(profile.id)).toHaveLength(0);
  });

  it('refuses a centre Elixia does not have', async () => {
    const profile = await linkedProfile();
    await expect(
      addSubscription(config, profile, { ...BODYPUMP, center: 'Atlantis' }, nowMs),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('stores the schedule\'s own spelling, not the one that was submitted', async () => {
    // Booking matches name and time against the listing exactly, so keeping a
    // user's "bodypump" or "9:00" would resolve to nothing on the day.
    const profile = await linkedProfile();
    const sub = await addSubscription(
      config,
      profile,
      { ...BODYPUMP, className: '  bodypump ', startTime: '9:00' },
      nowMs,
    );

    expect(sub).toMatchObject({ className: 'Bodypump', startTime: '09:00' });
  });

  it('cannot add a class before a gym account is linked', async () => {
    // Nothing can be checked against the schedule without a session, and
    // accepting it unchecked is exactly the hole this closes.
    const profile = await getOrCreateProfile(config, USER_ID);
    await expect(addSubscription(config, profile, BODYPUMP, nowMs)).rejects.toMatchObject({
      status: 409,
    });
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

  it('lists booked classes for the week starting Monday, then by time', async () => {
    // Added out of week order and out of time order within a day, so the
    // dashboard's order can only come from sorting, not insertion order.
    const profile = await linkedProfile();
    await addSubscription(config, profile, { ...BODYPUMP, weekday: 'friday' }, nowMs);
    await addSubscription(
      config,
      profile,
      { ...BODYPUMP, className: 'Busy Bootcamp', weekday: 'monday', startTime: '07:00' },
      nowMs,
    );
    await addSubscription(config, profile, { ...BODYPUMP, weekday: 'monday' }, nowMs);
    await addSubscription(config, profile, { ...BODYPUMP, weekday: 'wednesday' }, nowMs);

    const view = await buildDashboard(config, profile, nowMs);
    expect(view.subscriptions.map((s) => `${s.weekday} ${s.startTime} ${s.className}`)).toEqual([
      'monday 07:00 Busy Bootcamp',
      'monday 09:00 Bodypump',
      'wednesday 09:00 Bodypump',
      'friday 09:00 Bodypump',
    ]);
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
  it('rejects a timezone that was never on the list', async () => {
    const profile = await linkedProfile();
    await expect(
      updateSettings(config, profile, { ...SETUP, timeZone: 'Europe/Helsinky' }, nowMs),
    ).rejects.toThrow(/timezone/i);
  });

  it('rejects a booking window that is not one of the two memberships', async () => {
    const profile = await linkedProfile();
    await expect(
      updateSettings(config, profile, { ...SETUP, bookingWindowDays: 7.5 }, nowMs),
    ).rejects.toThrow(/membership/i);
  });

  it('reschedules when the tier changes, so the cron fires at the new times', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    const before = await repo.claimDue(0, nowMs + 30 * 86_400_000);
    await updateSettings(config, profile, { ...SETUP, bookingWindowDays: 14 }, nowMs);
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

  it('does not double-book when two ticks race for the same release', async () => {
    // The watcher's own loop can plausibly call this twice in quick
    // succession around one release — it fires the tick, and by the time
    // that request returns and the loop asks again, the same release can
    // still fall inside the next claim window. The second call must find
    // nothing left to claim.
    const profile = await linkedProfile();
    const sub = await addSubscription(config, profile, BODYPUMP, nowMs);

    setNow(firstRelease(sub) - 30_000);
    const [first, second] = await Promise.all([
      runDueBookings(config, nowMs, instantClock()),
      runDueBookings(config, nowMs, instantClock()),
    ]);

    expect(first + second).toBe(1);
    expect(await repo.listHistory(profile.id)).toHaveLength(1);
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

/**
 * A release is a race, and it has to be the same race for everyone in it.
 *
 * These are the tests for the tick handling users concurrently rather than one
 * after another. The measurement they all turn on is `firstAttemptOffsetMs`:
 * how far from T-0 a booking's first request actually went out. A booking that
 * has to queue behind someone else's retries does not fail — it just fires
 * seconds late, wins nothing, and reports a perfectly ordinary miss.
 */
describe('a release with several users in it', () => {
  /** Ten seconds of booking, the length of a full-ish retry sequence. */
  const SLOW_BOOKING_MS = 10_000;

  /** The mock gym, but every booking request takes real time to come back. */
  class SlowBookingBackend extends MockElixiaClient {
    constructor(
      private readonly pause: (ms: number) => Promise<void>,
      private readonly delayMs: number,
    ) {
      super();
    }

    override async book(tokens: StoredTokens, classId: string): Promise<AttemptOutcome> {
      await this.pause(this.delayMs);
      return super.book(tokens, classId);
    }
  }

  /** Both of these run on Tuesday at 09:00, so they share a release instant. */
  const SPIN = { ...BODYPUMP, className: 'Full House Spin' };

  async function offsetsByClass(userId: string): Promise<Record<string, number | null>> {
    const history = await repo.listHistory(userId);
    return Object.fromEntries(history.map((h) => [h.className, h.firstAttemptOffsetMs]));
  }

  it('fires every user’s booking at T-0, however slow another user’s is', async () => {
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    const aliceSub = await addSubscription(config, alice, BODYPUMP, nowMs);
    const bobSub = await addSubscription(config, bob, SPIN, nowMs);

    // The premise: without one shared release instant there is no race to be
    // fair about, and the assertions below would prove nothing.
    const release = firstRelease(aliceSub);
    expect(firstRelease(bobSub)).toBe(release);

    setNow(release - 30_000);
    const clock = instantClock();
    config.backend = new SlowBookingBackend(clock.sleep, SLOW_BOOKING_MS);

    expect(await runDueBookings(config, nowMs, clock)).toBe(2);

    // Serially, whoever went second could not even start sleeping to T-0 until
    // the first user's ten-second booking had come back.
    expect((await offsetsByClass(alice.id))['Bodypump']).toBe(0);
    expect((await offsetsByClass(bob.id))['Full House Spin']).toBe(0);
  });

  it('fires a user’s second class at T-0 rather than after their first', async () => {
    // The same queue, one level down: two classes opening at the same instant
    // for one person are still two independent races.
    const profile = await linkedProfile();
    const first = await addSubscription(config, profile, BODYPUMP, nowMs);
    const second = await addSubscription(config, profile, SPIN, nowMs);
    expect(firstRelease(second)).toBe(firstRelease(first));

    setNow(firstRelease(first) - 30_000);
    const clock = instantClock();
    config.backend = new SlowBookingBackend(clock.sleep, SLOW_BOOKING_MS);

    expect(await runDueBookings(config, nowMs, clock)).toBe(2);

    const offsets = await offsetsByClass(profile.id);
    expect(offsets['Bodypump']).toBe(0);
    expect(offsets['Full House Spin']).toBe(0);
  });

  it('books everyone else when one user’s profile cannot be read', async () => {
    // Concurrency turns a single failed read into a shared failure unless each
    // user's run is contained: one rejection would abandon every booking still
    // sleeping towards T-0.
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    const sub = await addSubscription(config, alice, BODYPUMP, nowMs);
    await addSubscription(config, bob, SPIN, nowMs);

    const getProfile = repo.getProfile.bind(repo);
    config.repo = {
      ...repo,
      getProfile: async (userId: string) => {
        if (userId === alice.id) throw new Error('connection reset');
        return getProfile(userId);
      },
    };

    setNow(firstRelease(sub) - 30_000);
    expect(await runDueBookings(config, nowMs, instantClock())).toBe(1);
    expect(await repo.listHistory(bob.id)).toHaveLength(1);
  });

  it('measures each booking’s log against its own release, not another’s', async () => {
    // Every log line carries its distance from T-0, and that is the number
    // anyone diagnosing a missed class reads first. Two bookings running side
    // by side have two different T-0s, so they cannot share the logger that
    // stamps them.
    const alice = await linkedProfile(USER_ID, 'alice@example.com');
    const bob = await linkedProfile(OTHER_ID, 'bob@example.com');
    const aliceSub = await addSubscription(config, alice, BODYPUMP, nowMs);
    const bobSub = await addSubscription(config, bob, BODYPUMP, nowMs);

    // Releases the mock timetable cannot express — 30s apart, both inside the
    // tick's claim window — written straight into the schedule.
    const tickAt = nowMs;
    const scheduled = await repo.claimDue(0, tickAt + 30 * 86_400_000);
    const rewrite = async (userId: string, subscriptionId: string, releaseEpochMs: number) => {
      const entry = scheduled.find((e) => e.subscriptionId === subscriptionId);
      // replaceDueEntries writes fresh, unclaimed rows, so the tick below can
      // still claim them despite the read above having taken the originals.
      await repo.replaceDueEntries(userId, [{ ...entry!, releaseEpochMs }]);
    };
    await rewrite(alice.id, aliceSub.id, tickAt + 10_000);
    await rewrite(bob.id, bobSub.id, tickAt + 40_000);

    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    });

    try {
      expect(await runDueBookings(config, tickAt, instantClock())).toBe(2);
    } finally {
      spy.mockRestore();
    }

    const attempts = lines.filter((l) => l['event'] === 'attempt.result');
    expect(attempts).toHaveLength(2);
    // Each request went out at its own release instant, so each line's own
    // offset is zero. A shared target would report one of them 30s out.
    expect(attempts.map((l) => l['offsetMs'])).toEqual([0, 0]);
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

describe('the class catalogue', () => {
  it('offers the centres the gym actually has', async () => {
    const profile = await linkedProfile();
    const centers = await listCenters(config, profile, nowMs);

    expect(centers.map((c) => c.name)).toContain('Tapiola');
    expect(centers.every((c) => c.id && c.name)).toBe(true);
  });

  it('offers a centre\'s published weekly slots, which is what may be subscribed to', async () => {
    const profile = await linkedProfile();
    const classes = await listClasses(config, profile, 'Tapiola', nowMs);

    expect(classes).toContainEqual({
      className: 'Bodypump',
      weekday: 'tuesday',
      startTime: '09:00',
    });
    // Every offered slot must be addable, or the chooser is offering fiction.
    for (const option of classes.slice(0, 3)) {
      await expect(
        addSubscription(config, profile, { ...option, center: 'Tapiola' }, nowMs),
      ).resolves.toMatchObject({ className: option.className });
    }
  });

  it('says an unknown centre is unknown rather than showing an empty timetable', async () => {
    const profile = await linkedProfile();
    await expect(listClasses(config, profile, 'Atlantis', nowMs)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('needs a linked gym account, since the schedule is behind the login', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    await expect(listCenters(config, profile, nowMs)).rejects.toMatchObject({ status: 409 });
  });

});

describe('the remembered centre', () => {
  it('is nothing at all until a first choice is made', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    expect(centerDefaults(profile)).toEqual({ center: '' });
  });

  it('keeps the centre a user last chose, so the next visit starts there', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    await saveCenterDefaults(config, profile, { center: '740' });

    const stored = await repo.getProfile(profile.id);
    expect(centerDefaults(stored!)).toEqual({ center: '740' });
  });

  it('forgets it when a blank arrives, rather than keeping the old one', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    const saved = await saveCenterDefaults(config, profile, { center: '740' });
    await saveCenterDefaults(config, saved, { center: '' });

    expect(centerDefaults((await repo.getProfile(profile.id))!)).toEqual({ center: '' });
  });

  it('does not touch the booking schedule, which the centre has no bearing on', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    const before = await repo.peekNextRelease(0);

    await saveCenterDefaults(config, profile, { center: '740' });

    expect(await repo.peekNextRelease(0)).toBe(before);
  });

  it('refuses a value too long to be a centre, rather than storing it', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    await expect(
      saveCenterDefaults(config, profile, { center: 'x'.repeat(300) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('classes that Elixia withdraws', () => {
  /**
   * A class dropped from the timetable is the mirror of the bug the chooser
   * fixed: the subscription stays in the list, resolves to nothing at T-0, and
   * reports "too early" — indistinguishable from a booking window that has not
   * opened. Nothing tells the owner, so this is the check that does.
   */

  /**
   * The mock gym, with one method swapped.
   *
   * Spelt out rather than spread from the instance: the mock's methods live on
   * its prototype, so `{...new MockElixiaClient()}` is an object with none of
   * them and every call would fail somewhere far from here.
   */
  function gym(overrides: Partial<BookingBackend> = {}): BookingBackend {
    const mock = new MockElixiaClient();
    return {
      login: (email, password, at) => mock.login(email, password, at),
      refresh: (tokens, at) => mock.refresh(tokens, at),
      listCenters: (tokens) => mock.listCenters(tokens),
      listClasses: (tokens, center) => mock.listClasses(tokens, center),
      resolveClassId: (tokens, sub, date) => mock.resolveClassId(tokens, sub, date),
      book: (tokens, id) => mock.book(tokens, id),
      ...overrides,
    };
  }

  /** The mock gym, minus the classes named. */
  function gymWithout(...withdrawn: string[]): void {
    const mock = new MockElixiaClient();
    config.backend = gym({
      listClasses: async (tokens, center) =>
        (await mock.listClasses(tokens, center)).filter((c) => !withdrawn.includes(c.className)),
    });
  }

  const only = async (userId = USER_ID): Promise<Subscription> =>
    (await repo.listSubscriptions(userId))[0]!;

  it('flags a class that is no longer on the schedule', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    expect((await only()).unlistedSinceMs).toBeUndefined();

    gymWithout('Bodypump');
    setNow(nowMs + 86_400_000);
    await reviewListedClasses(config, profile, nowMs);

    expect((await only()).unlistedSinceMs).toBe(nowMs);
  });

  it('leaves a class that is still on the schedule alone', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    await reviewListedClasses(config, profile, nowMs);
    expect((await only()).unlistedSinceMs).toBeUndefined();
  });

  it('keeps the date it was first missed, rather than resetting it nightly', async () => {
    // "Gone since Tuesday" is the useful fact; refreshing the timestamp every
    // night would say "gone since today" forever.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    gymWithout('Bodypump');
    const firstSeen = nowMs;
    await reviewListedClasses(config, profile, nowMs);

    setNow(nowMs + 3 * 86_400_000);
    await reviewListedClasses(config, profile, nowMs);
    expect((await only()).unlistedSinceMs).toBe(firstSeen);
  });

  it('clears the flag when the class comes back', async () => {
    // A class off for a holiday week is missing and then is not. Leaving it
    // flagged would train the owner to ignore the warning.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    gymWithout('Bodypump');
    await reviewListedClasses(config, profile, nowMs);
    expect((await only()).unlistedSinceMs).toBe(nowMs);

    delete config.backend;
    await reviewListedClasses(config, profile, nowMs);
    expect((await only()).unlistedSinceMs).toBeUndefined();
  });

  it('flags nothing when Elixia cannot be read', async () => {
    // The dangerous failure: one unreachable night marking every class of
    // every user as withdrawn.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    config.backend = gym({
      listClasses: async () => {
        throw new Error('elixia is down');
      },
    });

    await expect(reviewListedClasses(config, profile, nowMs)).resolves.toBeUndefined();
    expect((await only()).unlistedSinceMs).toBeUndefined();
  });

  it('tells the owner once, not every night', async () => {
    const linked = await linkedProfile();
    // The channel is explicit now: holding a chat id no longer implies alerts
    // go to Telegram, since every profile also has an email address.
    await repo.upsertProfile({ ...linked, telegramChatId: '4242', notifyChannel: 'telegram' });
    const withChat = (await repo.getProfile(USER_ID))!;
    await addSubscription(config, withChat, BODYPUMP, nowMs);

    const sent: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent.push(String(JSON.parse(String(init?.body)).text));
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    config.telegramBotToken = 'bot-token';

    try {
      gymWithout('Bodypump');
      await reviewListedClasses(config, withChat, nowMs);
      setNow(nowMs + 86_400_000);
      await reviewListedClasses(config, withChat, nowMs);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/Bodypump/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is run for every linked profile by the nightly job', async () => {
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);

    gymWithout('Bodypump');
    await runReindex(config, nowMs);

    expect((await only()).unlistedSinceMs).toBe(nowMs);
  });

  it('indexes everyone before reviewing anyone, and gives up reviewing when out of time', async () => {
    // The review reads a ~1.5MB page per centre per user, inside a function
    // capped at 60s. If that work were interleaved with the indexing, a slow
    // night would kill the job partway and leave the *later* users with no
    // computed releases at all — booking nothing, which is far worse than an
    // unreviewed listing. So indexing is finished for everyone first, and the
    // review is what gets dropped when the clock runs out.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    await repo.replaceDueEntries(profile.id, []);

    gymWithout('Bodypump');
    const indexed = await runReindex(config, nowMs, { deadlineMs: nowMs - 1 });

    expect(indexed).toBeGreaterThan(0);
    expect(await repo.claimDue(0, nowMs + 30 * 86_400_000)).not.toHaveLength(0);
    expect((await only()).unlistedSinceMs).toBeUndefined();
  });

  it('reads each centre once however many classes are booked there', async () => {
    // One read of a ~1.5MB page per centre, not per class.
    const profile = await linkedProfile();
    await addSubscription(config, profile, BODYPUMP, nowMs);
    await addSubscription(config, profile, { ...BODYPUMP, weekday: 'thursday' }, nowMs);
    await addSubscription(config, profile, { ...BODYPUMP, className: 'Yoga', weekday: 'monday', startTime: '17:00' }, nowMs);

    const mock = new MockElixiaClient();
    const centers: string[] = [];
    config.backend = gym({
      listClasses: async (tokens, center) => {
        centers.push(center);
        return mock.listClasses(tokens, center);
      },
    });

    await reviewListedClasses(config, profile, nowMs);
    expect(centers).toEqual(['Tapiola']);
  });
});
