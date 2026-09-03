import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import type { Profile } from '@/lib/types';

/**
 * /api/notify/test sends one alert down whichever channel the signed-in
 * account has chosen, so a user can confirm delivery without waiting on a
 * real booking to fire one.
 *
 * Auth is stubbed the same way /api/preferences' test stubs it — no session
 * exists in a test process — but the route and the service both run for real,
 * against a profile read from a real repo.
 */

const USER_ID = 'user_notify_test';
const repo = createMemoryRepo();
const base: Profile = {
  id: USER_ID,
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'email',
  notifyEmail: 'user@example.com',
  configuredAtMs: 0,
  elixiaStatus: 'unlinked',
};

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  requireConfiguredUser: async () => ({
    config: {
      repo,
      resendApiKey: 'resend-key',
      notifyFromEmail: 'Booker <bot@example.com>',
    },
    profile: (await repo.getProfile(USER_ID)) ?? base,
    nowMs: 0,
  }),
}));

const { POST } = await import('@/app/api/notify/test/route');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/notify/test', () => {
  it('sends to the address the account has on file, and says so', async () => {
    await repo.upsertProfile(base);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST();

    expect(await response.json()).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(init.body as string).to).toEqual(['user@example.com']);
  });

  it('reports the reason rather than throwing when nothing is configured to send it', async () => {
    await repo.upsertProfile({ ...base, notifyChannel: 'none' });

    const response = await POST();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/off/i);
  });
});
