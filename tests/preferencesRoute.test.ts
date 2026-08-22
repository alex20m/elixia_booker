import { describe, expect, it, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import type { Profile } from '@/lib/types';

/**
 * /api/preferences is where the chooser's centre survives between visits, so
 * what matters is the round trip: what a PUT stores is what the next GET
 * hands back.
 *
 * Auth is stubbed — no session exists in a test process — but the route, the
 * service and a real repo all run, and the profile is re-read from that repo
 * on every call exactly as `requireUser` does. A version that only mutated the
 * object in front of it would pass a same-request assertion and lose the
 * choice the moment the page was reloaded.
 */

const USER_ID = 'user_preferences';
const repo = createMemoryRepo();
const base: Profile = {
  id: USER_ID,
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  elixiaStatus: 'unlinked',
};

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  requireUser: async () => ({
    config: { repo },
    profile: (await repo.getProfile(USER_ID)) ?? base,
    nowMs: 0,
  }),
}));

const { GET, PUT } = await import('@/app/api/preferences/route');

const put = (body: unknown): Promise<Response> =>
  PUT(new Request('http://x/api/preferences', { method: 'PUT', body: JSON.stringify(body) }));

const read = async (): Promise<unknown> => (await (await GET()).json());

describe('/api/preferences', () => {
  it('has nothing to offer a user who has never chosen', async () => {
    expect(await read()).toEqual({ defaults: { center: '' } });
  });

  it('hands back on the next visit exactly what was saved', async () => {
    await put({ center: '740' });

    expect(await read()).toEqual({ defaults: { center: '740' } });
  });

  it('clears the centre when a blank arrives, rather than keeping the old one', async () => {
    await put({ center: '740' });
    await put({ center: '' });

    expect(await read()).toEqual({ defaults: { center: '' } });
  });

  it('refuses a value too long to be a centre', async () => {
    const response = await put({ center: 'x'.repeat(300) });
    expect(response.status).toBe(400);
  });
});
