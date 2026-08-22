import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import { hashLinkToken } from '@/lib/telegramLink';
import type { AppConfig } from '@/lib/appConfig';
import type { Profile } from '@/lib/types';

/**
 * The signed-in half of the connect flow: asking for a link, and giving one up.
 *
 * The service tests cover what a token is worth; this covers the wiring, which
 * is where a link would end up minted against the wrong account or handed back
 * in a field the page does not read.
 */

const NOW = Date.UTC(2026, 5, 1, 12, 0);
const repo = createMemoryRepo();

const base: Profile = {
  id: 'alice',
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyEmail: 'alice@example.com',
  elixiaStatus: 'unlinked',
};

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  requireUser: async () => ({
    config: {
      repo,
      telegramBotToken: 'bot-token',
      telegramBotUsername: 'elixia_booker_bot',
      telegramWebhookSecret: 'secret',
    } as unknown as AppConfig,
    profile: (await repo.getProfile('alice')) ?? base,
    nowMs: NOW,
  }),
}));

const { POST, DELETE } = await import('@/app/api/telegram/link/route');

beforeEach(async () => {
  await repo.upsertProfile(base);
});

describe('/api/telegram/link', () => {
  it('hands the page a link whose token the database is waiting for', async () => {
    const body = (await (await POST()).json()) as { url: string };

    const token = new URL(body.url).searchParams.get('start')!;
    expect(await repo.claimTelegramLink(hashLinkToken(token), NOW)).toBe('alice');
  });

  it('says when the link stops working, so the page can stop waiting on it', async () => {
    const body = (await (await POST()).json()) as { expiresAt: string };

    expect(Date.parse(body.expiresAt)).toBeGreaterThan(NOW);
  });

  it('disconnects the chat the signed-in user connected', async () => {
    await repo.upsertProfile({ ...base, telegramChatId: '555', notifyChannel: 'telegram' });

    const response = await DELETE();

    expect(response.status).toBe(200);
    const profile = await repo.getProfile('alice');
    expect(profile?.telegramChatId).toBeUndefined();
    // Left on Telegram with no chat: a state the dashboard warns about, rather
    // than a channel change the user never asked for.
    expect(profile?.notifyChannel).toBe('telegram');
  });
});
