import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import type { Profile } from '@/lib/types';

/**
 * /api/setup, and the gate every other route now sits behind.
 *
 * Two things are worth pinning at this level rather than in the service. The
 * gate has to answer **428** — the browser routes on that status alone, from
 * whichever request a half-configured session happens to make first, so a 400
 * or a 403 would land someone on an error card with no way forward. And
 * /api/setup itself has to stay *outside* the gate, or setup would require
 * having already been through setup.
 *
 * Auth is stubbed — no session exists in a test process — but the routes, the
 * service and a real repo all run, and the profile is re-read from that repo on
 * every call exactly as `requireUser` does.
 */

const USER_ID = 'user_setup_route';
const repo = createMemoryRepo();
const SESSION_EMAIL = 'signed-in@example.com';

vi.mock('@/lib/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/http')>();
  const { requireConfigured } = await import('@/lib/service');
  const session = async () => ({
    config: { repo } as never,
    profile: (await repo.getProfile(USER_ID)) ?? ({ id: USER_ID, elixiaStatus: 'unlinked' } as Profile),
    nowMs: 1_000,
    email: SESSION_EMAIL,
  });

  return {
    ...actual,
    requireUser: session,
    // The real one, over the stubbed session: this is the gate under test.
    requireConfiguredUser: async () => {
      const resolved = await session();
      return { ...resolved, profile: requireConfigured(resolved.profile) };
    },
  };
});

const { GET, POST } = await import('@/app/api/setup/route');
const { GET: ME } = await import('@/app/api/me/route');

const post = (body: unknown): Promise<Response> =>
  POST(new Request('http://x/api/setup', { method: 'POST', body: JSON.stringify(body) }));

const ANSWERS = {
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'email',
  notifyEmail: 'alerts@example.com',
};

beforeEach(async () => {
  await repo.upsertProfile({ id: USER_ID, elixiaStatus: 'unlinked' });
});

describe('/api/setup', () => {
  it('says setup is needed, and suggests the address the session carries', async () => {
    expect(await (await GET()).json()).toMatchObject({
      needed: true,
      suggestedEmail: SESSION_EMAIL,
    });
  });

  it('stores the answers and reports setup as done', async () => {
    const response = await post(ANSWERS);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needed: false });
    expect(await repo.getProfile(USER_ID)).toMatchObject({
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'email',
      notifyEmail: 'alerts@example.com',
    });
  });

  it('refuses an answer that was never on offer, and stores nothing', async () => {
    const response = await post({ ...ANSWERS, timeZone: 'Europe/Helsinky' });

    expect(response.status).toBe(400);
    expect((await repo.getProfile(USER_ID))?.timeZone).toBeUndefined();
  });
});

describe('the gate on every other route', () => {
  it('answers 428 until setup is finished, so the browser knows where to send them', async () => {
    const response = await ME();

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/setting up/i) });
  });

  it('lets the dashboard through once the answers are stored', async () => {
    await post(ANSWERS);

    expect((await ME()).status).toBe(200);
  });
});
