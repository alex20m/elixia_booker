import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import { hashLinkToken } from '@/lib/telegramLink';
import type { AppConfig } from '@/lib/appConfig';

/**
 * The Telegram webhook — the only route in the app that answers an
 * unauthenticated caller.
 *
 * Neon Auth cannot guard it, because Telegram is not signed in, so everything
 * protecting it is here: a shared secret Telegram echoes back on every call,
 * and a link token that is the sole thing tying a chat to an account. These
 * tests are written from the position of someone who has found the URL.
 *
 * The other half is Telegram's retry behaviour. A 5xx is retried, so anything
 * this route cannot make sense of — junk, chatter, an update shape we do not
 * handle — has to be answered 200 and dropped. A route that threw on malformed
 * input would turn one bad request into a retry loop.
 */

const SECRET = 'webhook-secret-value';
const TOKEN = 'a'.repeat(64);
const NOW = Date.UTC(2026, 5, 1, 12, 0);

const repo = createMemoryRepo();
let sent: Array<{ url: string; body: unknown }>;

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  loadCronConfig: (): AppConfig =>
    ({
      repo,
      encryptionKey: 'k',
      dryRun: false,
      mock: true,
      defaultBookingWindowDays: 7,
      defaultTimeZone: 'Europe/Helsinki',
      ephemeralStore: false,
      telegramBotToken: 'bot-token',
      telegramBotUsername: 'elixia_booker_bot',
      telegramWebhookSecret: SECRET,
    }) as AppConfig,
}));

const { POST } = await import('@/app/api/telegram/webhook/route');

const startUpdate = (token: string, chatId: unknown = 555): unknown => ({
  update_id: 1,
  message: {
    message_id: 7,
    from: { id: 999, is_bot: false, first_name: 'Someone' },
    chat: { id: chatId, type: 'private' },
    date: 1_700_000_000,
    text: `/start ${token}`,
  },
});

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  POST(
    new Request('http://x/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const authorised = (body: unknown): Promise<Response> =>
  post(body, { 'x-telegram-bot-api-secret-token': SECRET });

beforeEach(async () => {
  sent = [];
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch);
  vi.setSystemTime(NOW);

  await repo.upsertProfile({
    id: 'alice',
    bookingWindowDays: 7,
    timeZone: 'Europe/Helsinki',
    notifyEmail: 'alice@example.com',
    elixiaStatus: 'unlinked',
  });
  await repo.createTelegramLink('alice', hashLinkToken(TOKEN), NOW + 60_000, NOW);
});

describe('/api/telegram/webhook', () => {
  it('binds the chat that presented a valid token', async () => {
    const response = await authorised(startUpdate(TOKEN));

    expect(response.status).toBe(200);
    expect((await repo.getProfile('alice'))?.telegramChatId).toBe('555');
  });

  it('tells the chat it worked, so the user is not left watching a browser tab', async () => {
    await authorised(startUpdate(TOKEN));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('api.telegram.org');
    expect((sent[0]!.body as { chat_id: string }).chat_id).toBe('555');
  });

  it('refuses a caller who does not know the shared secret', async () => {
    const response = await post(startUpdate(TOKEN));

    expect(response.status).toBe(401);
    expect((await repo.getProfile('alice'))?.telegramChatId).toBeUndefined();
  });

  it('refuses a caller who guesses the secret wrong', async () => {
    const response = await post(startUpdate(TOKEN), {
      'x-telegram-bot-api-secret-token': 'webhook-secret-valuX',
    });

    expect(response.status).toBe(401);
    expect((await repo.getProfile('alice'))?.telegramChatId).toBeUndefined();
  });

  it('refuses every caller when the deployment forgot to configure a secret', async () => {
    // Open-by-default here would mean anyone could bind their chat to any
    // account that happened to be mid-connect.
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');

    const response = await authorised(startUpdate(TOKEN));

    expect(response.status).not.toBe(200);
    expect((await repo.getProfile('alice'))?.telegramChatId).toBeUndefined();
  });

  it('ignores a forged update carrying a token nobody minted', async () => {
    const response = await authorised(startUpdate('f'.repeat(64)));

    expect(response.status).toBe(200);
    expect((await repo.getProfile('alice'))?.telegramChatId).toBeUndefined();
  });

  it('spends a token on first use, so a replayed update binds nothing', async () => {
    await authorised(startUpdate(TOKEN));
    await authorised(startUpdate(TOKEN, 999));

    expect((await repo.getProfile('alice'))?.telegramChatId).toBe('555');
  });

  it('answers chatter with 200 rather than a retry-inducing error', async () => {
    const response = await authorised({
      update_id: 2,
      message: { chat: { id: 555 }, text: 'hello bot' },
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('answers a body that is not even JSON with 200, rather than looping forever', async () => {
    const response = await post('this is not json', {
      'x-telegram-bot-api-secret-token': SECRET,
    });

    expect(response.status).toBe(200);
  });

  it('refuses a body far larger than any update, without parsing it', async () => {
    const response = await post('x'.repeat(200_000), {
      'x-telegram-bot-api-secret-token': SECRET,
    });

    expect(response.status).toBe(413);
  });

  it('tells a user whose link went stale, instead of leaving them guessing', async () => {
    await authorised(startUpdate('b'.repeat(64)));

    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { text: string }).text).toMatch(/expired|again/i);
  });
});
