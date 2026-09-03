import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createMemoryRepo, type MemoryRepo } from '../lib/db/memoryRepo';
import {
  buildDashboard,
  completeSetup,
  getOrCreateProfile,
  requireConfigured,
  ServiceError,
  SETUP_REQUIRED_STATUS,
  setupState,
  updateSettings,
} from '../lib/service';
import { isConfigured } from '../lib/types';
import type { AppConfig } from '../lib/appConfig';

/**
 * Setup: the pages a new account has to go through before the app will do
 * anything, and the reason there is nothing to skip past.
 *
 * The rule these tests exist to hold is that **this app has no defaults**. A
 * booking window, a timezone and a notification channel are all decisions only
 * the user can make, and every one of them fails silently when guessed: the
 * wrong window fires a week early or a week late, the wrong zone an hour off,
 * an unchosen channel sends the "booking has stopped" alert to nobody. So a
 * profile starts empty, everything that would act on it refuses until it is
 * filled in, and each value is checked against the list the user was actually
 * offered rather than merely against being non-empty.
 */

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const USER_ID = 'user_setup';

let repo: MemoryRepo;
let config: AppConfig;
let nowMs: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  nowMs = Date.parse('2026-08-04T05:00:00Z');
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

const FULL = {
  bookingWindowDays: 14,
  timeZone: 'Europe/Stockholm',
  notifyChannel: 'email',
  notifyEmail: 'me@example.com',
};

describe('a brand new profile', () => {
  it('is created with nothing chosen for the user', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);

    expect(profile.bookingWindowDays).toBeUndefined();
    expect(profile.timeZone).toBeUndefined();
    expect(profile.notifyChannel).toBeUndefined();
    // Not even the address the session already carries: an address stored
    // without a channel chosen is a decision made on someone's behalf.
    expect(profile.notifyEmail).toBeUndefined();
    expect(isConfigured(profile)).toBe(false);
  });

  it('offers the signed-in address as a suggestion rather than storing it', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    const state = setupState(config, profile, 'me@example.com');

    expect(state.needed).toBe(true);
    expect(state.suggestedEmail).toBe('me@example.com');
    expect((await repo.getProfile(USER_ID))?.notifyEmail).toBeUndefined();
  });

  it('says the email channel cannot actually be reached when the deployment has no Resend key', async () => {
    // Email is offered as a channel regardless of whether the operator ever
    // set RESEND_API_KEY and NOTIFY_FROM_EMAIL up — see app/Setup.tsx, which
    // does not gate the option the way it gates Telegram's connect flow. A
    // profile that picks it anyway must be able to tell it will not work,
    // the same way telegramConnect tells it when Telegram cannot.
    const profile = await getOrCreateProfile(config, USER_ID);

    expect(setupState(config, profile, 'me@example.com').emailConfigured).toBe(false);
  });

  it('says the email channel works once the deployment has a Resend key and a sender', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    const live: AppConfig = {
      ...config,
      resendApiKey: 're_test_key',
      notifyFromEmail: 'Booker <bot@example.com>',
    };

    expect(setupState(live, profile, 'me@example.com').emailConfigured).toBe(true);
  });

  it('refuses to show a dashboard until setup is finished', async () => {
    const profile = await getOrCreateProfile(config, USER_ID);

    // 428 rather than 400: the request was fine, the account is not ready —
    // and the browser routes on that status straight to the setup pages.
    let thrown: ServiceError | undefined;
    try {
      await buildDashboard(config, requireConfigured(profile), nowMs);
    } catch (err) {
      thrown = err as ServiceError;
    }

    expect(thrown).toBeInstanceOf(ServiceError);
    expect(thrown?.status).toBe(SETUP_REQUIRED_STATUS);
  });
});

describe('finishing setup', () => {
  const complete = async (input: Record<string, unknown>) => {
    const profile = await getOrCreateProfile(config, USER_ID);
    return completeSetup(config, profile, input, nowMs);
  };

  it('stores exactly what was chosen, and nothing that was not', async () => {
    await complete(FULL);

    const stored = await repo.getProfile(USER_ID);
    expect(stored).toMatchObject({
      bookingWindowDays: 14,
      timeZone: 'Europe/Stockholm',
      notifyChannel: 'email',
      notifyEmail: 'me@example.com',
    });
    expect(isConfigured(stored!)).toBe(true);
    expect(stored?.configuredAtMs).toBe(nowMs);
  });

  it('lets the dashboard load once, and only once, everything is chosen', async () => {
    const configured = await complete(FULL);
    const view = await buildDashboard(config, requireConfigured(configured), nowMs);

    expect(view.account.bookingWindowDays).toBe(14);
    expect(view.account.timeZone).toBe('Europe/Stockholm');
    expect(setupState(config, configured, 'me@example.com').needed).toBe(false);
  });

  it('refuses a booking window that was never on the list', async () => {
    // 10 is a plausible guess, a valid column value, and not a tier Elixia
    // sells — which is exactly the kind of value a default would invent.
    await expect(complete({ ...FULL, bookingWindowDays: 10 })).rejects.toThrow(ServiceError);
    await expect(complete({ ...FULL, bookingWindowDays: undefined })).rejects.toThrow(ServiceError);
  });

  it('refuses a timezone that was never on the list, however valid it is', async () => {
    // Pacific/Chatham is a real zone and a real place. It is not one this app
    // offered, so a request carrying it did not come from the picker.
    await expect(complete({ ...FULL, timeZone: 'Pacific/Chatham' })).rejects.toThrow(ServiceError);
    await expect(complete({ ...FULL, timeZone: 'Europe/Helsinky' })).rejects.toThrow(ServiceError);
    await expect(complete({ ...FULL, timeZone: '' })).rejects.toThrow(ServiceError);
  });

  it('refuses to guess a notification channel', async () => {
    await expect(complete({ ...FULL, notifyChannel: undefined })).rejects.toThrow(ServiceError);
    await expect(complete({ ...FULL, notifyChannel: 'carrier-pigeon' })).rejects.toThrow(
      ServiceError,
    );
  });

  it('refuses email with nowhere to send it', async () => {
    await expect(complete({ ...FULL, notifyEmail: '' })).rejects.toThrow(ServiceError);
    await expect(complete({ ...FULL, notifyEmail: 'not-an-address' })).rejects.toThrow(ServiceError);
  });

  it('refuses Telegram until a chat is actually connected', async () => {
    // Choosing Telegram and walking away leaves a user who believes they are
    // covered and hears nothing — including when booking stops.
    await expect(
      complete({ ...FULL, notifyChannel: 'telegram', notifyEmail: undefined }),
    ).rejects.toThrow(ServiceError);

    const profile = await getOrCreateProfile(config, USER_ID);
    await repo.upsertProfile({ ...profile, telegramChatId: '4242' });

    const connected = await completeSetup(
      config,
      (await repo.getProfile(USER_ID))!,
      { ...FULL, notifyChannel: 'telegram', notifyEmail: undefined },
      nowMs,
    );
    expect(connected.notifyChannel).toBe('telegram');
    expect(isConfigured(connected)).toBe(true);
  });

  it('accepts switching notifications off, because that is a choice too', async () => {
    const off = await complete({ ...FULL, notifyChannel: 'none', notifyEmail: undefined });

    expect(off.notifyChannel).toBe('none');
    expect(isConfigured(off)).toBe(true);
  });

  it('leaves nothing stored when a submission is rejected', async () => {
    await expect(complete({ ...FULL, timeZone: 'Europe/Helsinky' })).rejects.toThrow(ServiceError);

    const stored = await repo.getProfile(USER_ID);
    expect(stored?.timeZone).toBeUndefined();
    expect(stored?.bookingWindowDays).toBeUndefined();
    expect(isConfigured(stored!)).toBe(false);
  });
});

describe('settings after setup', () => {
  const configured = async () => {
    const profile = await getOrCreateProfile(config, USER_ID);
    return completeSetup(config, profile, FULL, nowMs);
  };

  it('holds a saved change to the same standard the setup pages did', async () => {
    const profile = await configured();

    await expect(
      updateSettings(config, profile, { ...FULL, timeZone: 'Pacific/Chatham' }, nowMs),
    ).rejects.toThrow(ServiceError);
    await expect(
      updateSettings(config, profile, { ...FULL, bookingWindowDays: 10 }, nowMs),
    ).rejects.toThrow(ServiceError);

    const saved = await updateSettings(
      config,
      profile,
      { ...FULL, timeZone: 'Europe/Helsinki', bookingWindowDays: 7 },
      nowMs,
    );
    expect(saved.timeZone).toBe('Europe/Helsinki');
    expect(saved.bookingWindowDays).toBe(7);
  });

  it('never sends a configured account back through setup', async () => {
    const profile = await configured();
    const saved = await updateSettings(config, profile, { ...FULL, bookingWindowDays: 7 }, nowMs);

    expect(saved.configuredAtMs).toBe(profile.configuredAtMs);
    expect(isConfigured(saved)).toBe(true);
  });
});
