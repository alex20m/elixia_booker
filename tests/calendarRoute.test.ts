import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import type { AppConfig } from '@/lib/appConfig';
import type { Profile } from '@/lib/types';

/**
 * The signed-in half of calendar sync: turning it on or off for whoever is
 * asking. tests/calendarSync.test.ts covers what a token is worth; this
 * covers the wiring, which is where a request would end up acting on the
 * wrong account or handing back a field the page does not read.
 */

const repo = createMemoryRepo();

const base: Profile = {
  id: 'alice',
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'none',
  configuredAtMs: Date.now(),
  elixiaStatus: 'unlinked',
};

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  requireUser: async () => ({
    config: { repo } as unknown as AppConfig,
    profile: (await repo.getProfile('alice')) ?? base,
    nowMs: Date.now(),
  }),
}));

const { POST, DELETE } = await import('@/app/api/calendar/route');

const post = (body: unknown = {}): Promise<Response> =>
  POST(new Request('http://x/api/calendar', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(async () => {
  await repo.upsertProfile(base);
});

describe('/api/calendar', () => {
  it('turns sync on and hands back a token the feed route will accept', async () => {
    const body = (await (await post()).json()) as { enabled: boolean; token: string };

    expect(body.enabled).toBe(true);
    expect(await repo.getProfileByCalendarToken(body.token)).not.toBeNull();
  });

  it('keeps the same token on a second call', async () => {
    const first = (await (await post()).json()) as { token: string };
    const second = (await (await post()).json()) as { token: string };

    expect(second.token).toBe(first.token);
  });

  it('mints a new token when asked to regenerate', async () => {
    const first = (await (await post()).json()) as { token: string };
    const second = (await (await post({ regenerate: true })).json()) as { token: string };

    expect(second.token).not.toBe(first.token);
    expect(await repo.getProfileByCalendarToken(first.token)).toBeNull();
  });

  it('turns sync off without erasing the token', async () => {
    const { token } = (await (await post()).json()) as { token: string };

    const response = await DELETE();

    expect(response.status).toBe(200);
    const profile = await repo.getProfile('alice');
    expect(profile?.calendarSyncEnabled).toBe(false);
    expect(profile?.calendarFeedToken).toBe(token);
  });
});
