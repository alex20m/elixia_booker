import { describe, expect, it, vi } from 'vitest';
import { notifyChat, notifyUser, truncateForTelegram } from '../lib/notify';

const BOT_TOKEN = 'bot-token';

const okResponse = (): Response => new Response('{"ok":true}', { status: 200 });

describe('truncateForTelegram', () => {
  it('leaves a short message alone', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });

  it('trims to Telegram’s limit, which would otherwise reject the message', () => {
    const out = truncateForTelegram('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/truncated/);
  });
});

describe('notifyChat', () => {
  it('posts to the chat id the user configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await notifyChat(BOT_TOKEN, '12345', 'Booked Bodypump', fetchImpl as unknown as typeof fetch);

    expect(result.sent).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/botbot-token/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toBe('Booked Bodypump');
  });

  it('does not set parse_mode, so arbitrary class names cannot break the send', async () => {
    // An unescaped underscore in Markdown mode makes Telegram reject the whole
    // message — losing the alert to a formatting detail.
    const fetchImpl = vi.fn(async () => okResponse());

    await notifyChat(BOT_TOKEN, '1', 'Body_Pump 50%', fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).parse_mode).toBeUndefined();
  });

  it('is a silent no-op for a user who set no chat id', async () => {
    // Most users will not configure Telegram. That must never fail a run that
    // otherwise succeeded.
    const fetchImpl = vi.fn();

    const result = await notifyChat(BOT_TOKEN, undefined, 'anything', fetchImpl as unknown as typeof fetch);

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op when the operator configured no bot token', async () => {
    const fetchImpl = vi.fn();

    const result = await notifyChat(undefined, '12345', 'x', fetchImpl as unknown as typeof fetch);

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports rather than throws when Telegram returns an error', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));

    const result = await notifyChat(BOT_TOKEN, '1', 'x', fetchImpl as unknown as typeof fetch);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/400/);
  });

  it('swallows a network failure so a booking result is never lost to it', async () => {
    // The booking already happened; a dead notifier must not turn that into a
    // thrown error that masks the outcome.
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    const result = await notifyChat(BOT_TOKEN, '1', 'x', fetchImpl as unknown as typeof fetch);

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/ECONNRESET/);
  });

  it('truncates an oversized message before sending', async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    await notifyChat(BOT_TOKEN, '1', 'y'.repeat(9000), fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).text.length).toBeLessThanOrEqual(4096);
  });
});

/**
 * Which channel a message actually leaves by.
 *
 * The dispatcher is the only place that decides, and it decides from the
 * profile alone — so these assert on the URL that was called, which is the
 * observable difference between "went to Telegram" and "went to email".
 */
describe('notifyUser', () => {
  const CONFIG = {
    telegramBotToken: 'bot-token-value',
    resendApiKey: 're_key_value',
    notifyFromEmail: 'Booker <bot@example.com>',
  };
  const hostOf = (fetchImpl: ReturnType<typeof vi.fn>): string =>
    new URL(fetchImpl.mock.calls[0]![0] as string).host;

  const spyFetch = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

  it('emails a user who has expressed no preference, so a new account is reachable', async () => {
    const fetchImpl = spyFetch();

    const result = await notifyUser(
      CONFIG,
      { notifyEmail: 'user@example.com', telegramChatId: '42' },
      'Booked your class',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result).toEqual({ sent: true });
    expect(hostOf(fetchImpl)).toBe('api.resend.com');
  });

  it('sends to Telegram when that is what the user chose', async () => {
    const fetchImpl = spyFetch();

    await notifyUser(
      { ...CONFIG },
      { notifyChannel: 'telegram', notifyEmail: 'user@example.com', telegramChatId: '42' },
      'Booked your class',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(hostOf(fetchImpl)).toBe('api.telegram.org');
  });

  it('sends nothing at all for a user who switched notifications off', async () => {
    const fetchImpl = spyFetch();

    const result = await notifyUser(
      CONFIG,
      { notifyChannel: 'none', notifyEmail: 'user@example.com', telegramChatId: '42' },
      'Booked your class',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fall back to email when Telegram is chosen but never connected', async () => {
    // Falling back would be a privacy surprise: the user picked the channel
    // their gym schedule should go to, and an unconnected chat is a setup step
    // they have not finished — not permission to use a different one.
    const fetchImpl = spyFetch();

    const result = await notifyUser(
      CONFIG,
      { notifyChannel: 'telegram', notifyEmail: 'user@example.com' },
      'Booked your class',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('titles the email with the alert itself, so the subject line says what happened', async () => {
    const fetchImpl = spyFetch();

    await notifyUser(
      CONFIG,
      { notifyChannel: 'email', notifyEmail: 'user@example.com' },
      '✅ Booked Yoga @ Kamppi, 2026-09-01 07:00\nfired +12ms from T-0',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.subject).toBe('✅ Booked Yoga @ Kamppi, 2026-09-01 07:00');
    expect(body.text).toContain('fired +12ms from T-0');
  });
});
