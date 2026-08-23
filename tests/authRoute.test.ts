import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/auth/[...path] — the proxy in front of the managed Better Auth
 * instance, and the one place account deletion passes through.
 *
 * Neon Auth is managed remotely and has no hook of its own for the app to run
 * cleanup from when an account is deleted, so this proxy purges the app's own
 * data itself, right after the identity is confirmed gone. These tests pin
 * exactly when that purge does and does not fire: on the immediate-deletion
 * response, on the verification callback's redirect, and never on a request
 * that merely *asks* for deletion (which may only have sent an email), never
 * on an unrelated auth request, and never without a session to attribute the
 * purge to.
 */

const getSession = vi.fn();
const postHandler = vi.fn();
const getHandler = vi.fn();

vi.mock('@/lib/auth/neonAuth', () => ({
  neonAuth: () => ({
    getSession,
    handler: () => ({
      GET: getHandler,
      POST: postHandler,
      PUT: vi.fn(),
      DELETE: vi.fn(),
      PATCH: vi.fn(),
    }),
  }),
}));

vi.mock('@/lib/db/neon', () => ({
  neonSql: () => ({}) as never,
}));

vi.mock('@/lib/db/neonRepo', () => ({
  createNeonRepo: () => ({}) as never,
}));

vi.mock('@/lib/appConfig', () => ({
  loadAppConfig: (options: { repo: unknown }) => ({ repo: options.repo }),
}));

vi.mock('@/lib/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/service')>()),
  deleteAccount: vi.fn(),
}));

const { deleteAccount } = await import('@/lib/service');
const { GET, POST } = await import('@/app/api/auth/[...path]/route');

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { user: { id: 'user_deleting' } } });
});

describe('POST /api/auth/delete-user', () => {
  it('purges the app data once the identity is actually deleted', async () => {
    postHandler.mockResolvedValue(jsonResponse({ success: true, message: 'User deleted' }));

    const response = await POST(new Request('http://x/api/auth/delete-user', { method: 'POST' }), context([
      'delete-user',
    ]));

    expect(deleteAccount).toHaveBeenCalledWith(expect.anything(), 'user_deleting');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: 'User deleted' });
  });

  it('does not purge anything when a verification email was sent instead', async () => {
    // Betting the deletion happened here would wipe a still-live account's
    // Elixia credentials and subscriptions before the user has even clicked
    // the confirmation link.
    postHandler.mockResolvedValue(jsonResponse({ success: true, message: 'Verification email sent' }));

    await POST(new Request('http://x/api/auth/delete-user', { method: 'POST' }), context(['delete-user']));

    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('does not purge anything when the deletion attempt failed', async () => {
    postHandler.mockResolvedValue(jsonResponse({ error: 'Invalid password' }, 400));

    await POST(new Request('http://x/api/auth/delete-user', { method: 'POST' }), context(['delete-user']));

    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('does not purge anything with no session to attribute it to', async () => {
    getSession.mockResolvedValue({ data: null });
    postHandler.mockResolvedValue(jsonResponse({ success: true, message: 'User deleted' }));

    await POST(new Request('http://x/api/auth/delete-user', { method: 'POST' }), context(['delete-user']));

    expect(deleteAccount).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/delete-user/callback', () => {
  it('purges the app data on the redirect a verified deletion answers with', async () => {
    getHandler.mockResolvedValue(new Response(null, { status: 302, headers: { location: '/auth/sign-out' } }));

    const response = await GET(
      new Request('http://x/api/auth/delete-user/callback?token=abc'),
      context(['delete-user', 'callback']),
    );

    expect(deleteAccount).toHaveBeenCalledWith(expect.anything(), 'user_deleting');
    expect(response.status).toBe(302);
  });

  it('does not purge anything when the token is rejected', async () => {
    getHandler.mockResolvedValue(jsonResponse({ error: 'Invalid token' }, 404));

    await GET(
      new Request('http://x/api/auth/delete-user/callback?token=bad'),
      context(['delete-user', 'callback']),
    );

    expect(deleteAccount).not.toHaveBeenCalled();
  });
});

describe('every other auth request', () => {
  it('passes straight through, without touching the session at all', async () => {
    postHandler.mockResolvedValue(jsonResponse({ ok: true }));

    const response = await POST(
      new Request('http://x/api/auth/sign-in/email', { method: 'POST' }),
      context(['sign-in', 'email']),
    );

    expect(getSession).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ ok: true });
  });
});
