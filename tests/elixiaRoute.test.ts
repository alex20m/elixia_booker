import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRepo, type MemoryRepo } from '@/lib/db/memoryRepo';
import type { AppConfig } from '@/lib/appConfig';
import type { Profile } from '@/lib/types';

/**
 * /api/elixia — link a gym account, edit the credentials of the one already
 * linked, or forget it.
 *
 * PATCH is the endpoint this file exists for. Editing used to mean DELETE
 * followed by POST, which erases the queued bookings on the way through, so
 * the properties worth pinning are that PATCH keeps the link intact and that a
 * rejected edit changes nothing at all — a mistyped password must not cost
 * someone the link they already had.
 *
 * Auth is stubbed, as no session exists in a test process, but the route, the
 * service, the seal and a real repo all run, and the profile is re-read from
 * that repo on every call exactly as `requireUser` does.
 */

const USER_ID = 'user_elixia_route';
const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

let repo: MemoryRepo;
let config: AppConfig;

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
    config,
    profile: (await repo.getProfile(USER_ID)) ?? base,
    nowMs: 0,
  }),
}));

const { DELETE, PATCH, POST } = await import('@/app/api/elixia/route');

const send = (
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<Response> =>
  (method === 'POST' ? POST : PATCH)(
    new Request('http://x/api/elixia', { method, body: JSON.stringify(body) }),
  );

const link = (): Promise<Response> =>
  send('POST', { email: 'gym@example.com', password: 'correct-horse' });

const stored = async (): Promise<Profile> => (await repo.getProfile(USER_ID))!;

beforeEach(async () => {
  repo = createMemoryRepo();
  config = {
    repo,
    encryptionKey: ENCRYPTION_KEY,
    dryRun: false,
    mock: true,
    ephemeralStore: true,
  };
  await repo.upsertProfile(base);
});

describe('/api/elixia', () => {
  it('links an account and marks it working', async () => {
    expect((await link()).status).toBe(200);

    expect((await stored()).elixiaEmail).toBe('gym@example.com');
    expect((await stored()).elixiaStatus).toBe('ok');
  });

  it('edits the address of the linked account without being given the password', async () => {
    await link();

    const response = await send('PATCH', { email: 'moved@example.com' });

    expect(response.status).toBe(200);
    expect((await stored()).elixiaEmail).toBe('moved@example.com');
    expect((await stored()).elixiaStatus).toBe('ok');
  });

  it('edits the password while keeping the linked address', async () => {
    await link();

    expect((await send('PATCH', { password: 'new-passphrase' })).status).toBe(200);

    expect((await stored()).elixiaEmail).toBe('gym@example.com');
    expect(repo.dump()).not.toContain('new-passphrase');
  });

  it('leaves the existing link alone when Elixia rejects the edit', async () => {
    await link();

    // The mock backend refuses a password this short, as the real one would.
    const response = await send('PATCH', { password: 'x' });

    expect(response.status).toBe(401);
    expect((await stored()).elixiaEmail).toBe('gym@example.com');
    expect((await stored()).elixiaStatus).toBe('ok');
  });

  it('refuses to edit when nothing is linked yet', async () => {
    const response = await send('PATCH', { email: 'gym@example.com' });

    expect(response.status).toBe(409);
    expect((await stored()).elixiaStatus).toBe('unlinked');
  });

  it('never echoes the credentials back to the browser', async () => {
    await link();

    const body = await (await send('PATCH', { password: 'another-one' })).json();

    expect(body).toEqual({ ok: true });
  });

  it('forgets the credentials on unlink', async () => {
    await link();

    expect((await DELETE()).status).toBe(200);

    expect((await stored()).elixiaStatus).toBe('unlinked');
    expect((await stored()).elixiaEmail).toBeUndefined();
  });
});
