import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import {
  ServiceError,
  completeTelegramLink,
  disconnectTelegram,
  requireConfigured,
  startTelegramLink,
  updateSettings,
} from '@/lib/service';
import { channelFor } from '@/lib/notify';
import { hashLinkToken } from '@/lib/telegramLink';
import type { AppConfig } from '@/lib/appConfig';
import type { ConfiguredProfile, Profile } from '@/lib/types';

/**
 * Choosing a channel, and connecting a Telegram chat to an account.
 *
 * The connect flow is the part that has to be got right: its webhook is a
 * public endpoint, so the token is the only thing standing between "this chat
 * belongs to Alice" and anyone claiming Alice's alerts. These exercise it
 * through the service, against a real repo, because the token's single use and
 * its expiry are properties of the storage as much as of the code.
 */

const NOW = Date.UTC(2026, 5, 1, 12, 0);

let repo: ReturnType<typeof createMemoryRepo>;
let config: AppConfig;

const baseConfig = (): AppConfig =>
  ({
    repo,
    encryptionKey: 'k',
    dryRun: false,
    mock: true,
    ephemeralStore: false,
    telegramBotToken: 'bot-token',
    telegramBotUsername: 'elixia_booker_bot',
    telegramWebhookSecret: 'webhook-secret',
  }) as AppConfig;

/**
 * Every profile here has been through setup, because everything below is
 * behind it: there is no state in which someone is choosing a channel without
 * having chosen a booking window and a timezone first.
 */
const profileOf = async (id = 'alice'): Promise<ConfiguredProfile> =>
  requireConfigured((await repo.getProfile(id)) as Profile);

beforeEach(async () => {
  repo = createMemoryRepo();
  config = baseConfig();
  await repo.upsertProfile({
    id: 'alice',
    bookingWindowDays: 7,
    timeZone: 'Europe/Helsinki',
    notifyChannel: 'email',
    notifyEmail: 'alice@example.com',
    elixiaStatus: 'unlinked',
    configuredAtMs: NOW,
  });
});

describe('updateSettings', () => {
  const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    bookingWindowDays: 7,
    timeZone: 'Europe/Helsinki',
    notifyChannel: 'email',
    notifyEmail: 'alice@example.com',
    ...overrides,
  });

  it('saves the channel the user picked', async () => {
    await updateSettings(config, await profileOf(), settings({ notifyChannel: 'none' }), NOW);

    expect((await profileOf()).notifyChannel).toBe('none');
  });

  it('refuses a channel the app does not have', async () => {
    await expect(
      updateSettings(config, await profileOf(), settings({ notifyChannel: 'carrier-pigeon' }), NOW),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('refuses to leave email selected with nowhere to send it', async () => {
    // Silently accepting this is how a user ends up believing they are covered
    // while every alert is dropped for want of an address.
    await expect(
      updateSettings(config, await profileOf(), settings({ notifyEmail: '' }), NOW),
    ).rejects.toThrow(/email/i);
  });

  it('lets an unrelated setting be saved while a channel is missing its destination', async () => {
    // Disconnecting Telegram leaves the channel chosen and the chat gone. That
    // is worth a warning, not a wall: changing a timezone must not fail with an
    // error about a chat the form in front of the user does not mention.
    await repo.upsertProfile({
      id: 'dave',
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'telegram',
      elixiaStatus: 'unlinked',
      configuredAtMs: NOW,
    });

    await updateSettings(
      config,
      await profileOf('dave'),
      { bookingWindowDays: 14, timeZone: 'Europe/Stockholm' },
      NOW,
    );

    expect((await profileOf('dave')).timeZone).toBe('Europe/Stockholm');
  });

  it('leaves the chosen channel alone when a form does not carry it', async () => {
    // Otherwise any request that omits the field silently moves a Telegram
    // user onto email — a channel change nobody asked for.
    await repo.upsertProfile({ ...(await profileOf()), notifyChannel: 'telegram' });

    await updateSettings(
      config,
      await profileOf(),
      { bookingWindowDays: 14, timeZone: 'Europe/Helsinki' },
      NOW,
    );

    expect((await profileOf()).notifyChannel).toBe('telegram');
  });

  it('refuses an address that is not one', async () => {
    await expect(
      updateSettings(config, await profileOf(), settings({ notifyEmail: 'not-an-address' }), NOW),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('lets a user on Telegram clear their address entirely', async () => {
    await repo.upsertProfile({ ...(await profileOf()), telegramChatId: '555' });

    await updateSettings(
      config,
      await profileOf(),
      settings({ notifyChannel: 'telegram', notifyEmail: '' }),
      NOW,
    );

    expect((await profileOf()).notifyEmail).toBeUndefined();
  });

  it('refuses to leave Telegram selected with no chat connected', async () => {
    // The same trap as an empty email address, from the other side: a channel
    // that reaches nobody, chosen by someone who thinks they are covered.
    await expect(
      updateSettings(config, await profileOf(), settings({ notifyChannel: 'telegram' }), NOW),
    ).rejects.toThrow(/telegram/i);
  });

  it('refuses a chat id that is really a public channel handle', async () => {
    // Telegram resolves an @handle to a channel, so accepting one would post
    // somebody's gym schedule where anyone can read it.
    await expect(
      updateSettings(
        config,
        await profileOf(),
        settings({ notifyChannel: 'telegram', telegramChatId: '@some_channel' }),
        NOW,
      ),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('keeps a connected chat when settings are saved without mentioning it', async () => {
    // The chat id belongs to the connect flow now. A settings form that does
    // not carry it must not be read as a request to disconnect.
    await repo.upsertProfile({ ...(await profileOf()), telegramChatId: '555' });

    await updateSettings(config, await profileOf(), settings(), NOW);

    expect((await profileOf()).telegramChatId).toBe('555');
  });
});

describe('startTelegramLink', () => {
  it('hands back a t.me link carrying a token the database is waiting for', async () => {
    const { url } = await startTelegramLink(config, await profileOf(), NOW);

    const token = new URL(url).searchParams.get('start')!;
    expect(url.startsWith('https://t.me/elixia_booker_bot?start=')).toBe(true);
    expect(await repo.claimTelegramLink(hashLinkToken(token), NOW)).toBe('alice');
  });

  it('never stores the token itself, only something that proves one', async () => {
    const { url } = await startTelegramLink(config, await profileOf(), NOW);
    const token = new URL(url).searchParams.get('start')!;

    expect(repo.dump()).not.toContain(token);
  });

  it('mints a different token every time it is asked', async () => {
    const first = await startTelegramLink(config, await profileOf(), NOW);
    const second = await startTelegramLink(config, await profileOf(), NOW);

    expect(first.url).not.toBe(second.url);
  });

  it('says what is missing when the deployment has no bot configured', async () => {
    const { telegramBotUsername: _omitted, ...withoutUsername } = config;

    await expect(
      startTelegramLink(withoutUsername as AppConfig, await profileOf(), NOW),
    ).rejects.toThrow(/TELEGRAM_BOT_USERNAME/);
  });
});

describe('completeTelegramLink', () => {
  const start = async (): Promise<string> => {
    const { url } = await startTelegramLink(config, await profileOf(), NOW);
    return new URL(url).searchParams.get('start')!;
  };

  it('binds the chat that presented the token, and switches the user to Telegram', async () => {
    const token = await start();

    expect(await completeTelegramLink(config, token, '555', NOW)).toBe('linked');

    const profile = await profileOf();
    expect(profile.telegramChatId).toBe('555');
    expect(profile.notifyChannel).toBe('telegram');
  });

  it('refuses a token that has already been used', async () => {
    const token = await start();
    await completeTelegramLink(config, token, '555', NOW);

    expect(await completeTelegramLink(config, token, '999', NOW)).toBe('expired');
    expect((await profileOf()).telegramChatId).toBe('555');
  });

  it('refuses a token past its ten minutes', async () => {
    const token = await start();

    expect(await completeTelegramLink(config, token, '555', NOW + 11 * 60_000)).toBe('expired');
    expect((await profileOf()).telegramChatId).toBeUndefined();
  });

  it('refuses a token nobody minted, which is what a forged update carries', async () => {
    expect(await completeTelegramLink(config, 'f'.repeat(64), '555', NOW)).toBe('expired');
  });
});

describe('disconnectTelegram', () => {
  it('forgets the chat and leaves the channel exactly where the user put it', async () => {
    const token = new URL((await startTelegramLink(config, await profileOf(), NOW)).url)
      .searchParams.get('start')!;
    await completeTelegramLink(config, token, '555', NOW);

    await disconnectTelegram(config, await profileOf());

    const profile = await profileOf();
    expect(profile.telegramChatId).toBeUndefined();
    // Not moved to email on their behalf. Rerouting a gym schedule to an inbox
    // nobody nominated is the kind of helpful guess this app does not make; the
    // dashboard says the chat is gone instead.
    expect(profile.notifyChannel).toBe('telegram');
  });

  it('leaves a user who was already on email where they are', async () => {
    // Asserted through `channelFor`, which is what the dispatcher routes on.
    await disconnectTelegram(config, await profileOf());

    expect(channelFor(await profileOf())).toBe('email');
  });
});
