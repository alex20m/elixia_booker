import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/auth/[...path] — the proxy in front of the managed Better Auth
 * instance, and the one place account deletion is handled.
 *
 * The managed instance has no `/delete-user` route of its own, so deletion is
 * not forwarded: the route deletes the identity through the Neon Console API
 * (lib/auth/neonUsers.ts), then purges the app's own data — which no upstream
 * hook would ever run because the schema keeps no foreign key back to it — and
 * clears the session. These tests pin that the purge only fires once the
 * identity is actually gone, never before, and never for an unrelated auth
 * request.
 */

const getSession = vi.fn();
const signOut = vi.fn();
const postHandler = vi.fn();
const getHandler = vi.fn();

vi.mock('@/lib/auth/neonAuth', () => ({
  neonAuth: () => ({
    getSession,
    signOut,
    handler: () => ({
      GET: getHandler,
      POST: postHandler,
      PUT: vi.fn(),
      DELETE: vi.fn(),
      PATCH: vi.fn(),
    }),
  }),
}));

vi.mock('@/lib/auth/neonUsers', () => ({
  deleteNeonAuthUser: vi.fn(),
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
const { deleteNeonAuthUser } = await import('@/lib/auth/neonUsers');
const { GET, POST } = await import('@/app/api/auth/[...path]/route');

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const deleteUserRequest = () =>
  POST(new Request('http://x/api/auth/delete-user', { method: 'POST' }), context(['delete-user']));

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { user: { id: 'user_deleting' } } });
  signOut.mockResolvedValue({ data: {}, error: null });
  vi.mocked(deleteNeonAuthUser).mockResolvedValue(undefined);
});

describe('POST /api/auth/delete-user', () => {
  it('deletes the identity via the Neon API, then purges the app data and clears the session', async () => {
    const response = await deleteUserRequest();

    expect(deleteNeonAuthUser).toHaveBeenCalledWith('user_deleting');
    expect(deleteAccount).toHaveBeenCalledWith(expect.anything(), 'user_deleting');
    expect(signOut).toHaveBeenCalled();
    expect(postHandler).not.toHaveBeenCalled(); // never forwarded upstream — there is no route there
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  it('does not purge anything when deleting the identity fails, and surfaces the reason', async () => {
    // Betting the deletion happened would wipe a still-live account's Elixia
    // credentials and subscriptions.
    vi.mocked(deleteNeonAuthUser).mockRejectedValue(
      new Error('Neon API refused to delete the user (HTTP 403)'),
    );

    const response = await deleteUserRequest();

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Neon API refused to delete the user (HTTP 403)',
    });
  });

  it('refuses with 401 and touches nothing when there is no session', async () => {
    getSession.mockResolvedValue({ data: null });

    const response = await deleteUserRequest();

    expect(deleteNeonAuthUser).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it('still reports success when the post-deletion cleanup fails — the identity is already gone', async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error('database unreachable'));
    signOut.mockRejectedValue(new Error('sign-out blipped'));

    const response = await deleteUserRequest();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
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

/**
 * GET /api/auth/get-session — the check every sign-in makes of itself right
 * after it succeeds.
 *
 * Neon Auth's own handler makes this call twice over on a fresh sign-in: once
 * inside the proxy, to mint the signed session-data cache cookie from the new
 * session token, and again when the client refetches its session afterwards.
 * A one-off blip talking to the managed instance — the kind that clears on the
 * next attempt — turns either of those into a 502 with no session in it. The
 * credentials were correct and the session cookie is already sitting on the
 * response; the only thing that failed was this follow-up check. But the
 * sign-in form has no way to tell "your password was wrong" apart from "the
 * session check after your password was right happened to blip", so it shows
 * the same dead end either way: the password field clears, a toast most people
 * scroll past fires, and the visitor is left signed in but looking signed out
 * until they reload the page by hand or try again and get lucky.
 *
 * The fix is narrow on purpose: retry this one idempotent GET, once, and only
 * for this one path. A wrong password is a 200 with an empty session, never a
 * 502, so a retry here can never paper over a real failure — it only absorbs
 * the network blip the credentials already survived.
 */
describe('GET /api/auth/get-session', () => {
  it('retries once when the upstream blips, so a transient failure right after signing in does not read as a failed session', async () => {
    getHandler
      .mockResolvedValueOnce(jsonResponse({ error: 'upstream timed out', code: 'NETWORK_TIMEOUT' }, 502))
      .mockResolvedValueOnce(jsonResponse({ session: { id: 's1' }, user: { id: 'user_1' } }));

    const response = await GET(new Request('http://x/api/auth/get-session'), context(['get-session']));

    expect(getHandler).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { id: 's1' }, user: { id: 'user_1' } });
  });

  it('gives up after one retry rather than hiding a real, sustained outage', async () => {
    getHandler.mockResolvedValue(jsonResponse({ error: 'upstream timed out', code: 'NETWORK_TIMEOUT' }, 502));

    const response = await GET(new Request('http://x/api/auth/get-session'), context(['get-session']));

    expect(getHandler).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(502);
  });

  it('does not retry a request that already has an answer', async () => {
    getHandler.mockResolvedValue(jsonResponse({ session: null, user: null }));

    const response = await GET(new Request('http://x/api/auth/get-session'), context(['get-session']));

    expect(getHandler).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ session: null, user: null });
  });

  it('leaves every other GET alone, even one that also 502s', async () => {
    getHandler.mockResolvedValue(jsonResponse({ error: 'nope' }, 502));

    const response = await GET(new Request('http://x/api/auth/list-sessions'), context(['list-sessions']));

    expect(getHandler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
  });
});

/**
 * The link in the verification email.
 *
 * Better Auth verifies the token, sets the session cookie, and only then looks
 * at `callbackURL` to decide whether to answer with a redirect or with JSON —
 * so the cookie is already on the response either way. That ordering is the
 * whole reason the redirect can be taken away from it: the proxy in front of
 * Neon Auth reaches upstream with a plain `fetch`, which follows redirects
 * itself, and a followed redirect's `Set-Cookie` never reaches the browser.
 * With `callbackURL` left on, the visitor arrived back at the app with the
 * session dropped somewhere inside a server-side fetch — signed out, on the
 * page they had just verified their way past.
 */
describe('GET /api/auth/verify-email', () => {
  it('keeps the session cookie the verification set instead of losing it to a followed redirect', async () => {
    getHandler.mockImplementation(async (request: Request) => {
      // What upstream answers only when nothing asked it to redirect.
      expect(new URL(request.url).searchParams.has('callbackURL')).toBe(false);
      expect(new URL(request.url).searchParams.get('token')).toBe('tok');
      const response = jsonResponse({ status: true, user: null });
      response.headers.append('set-cookie', 'neon-auth.session_token=abc; Path=/; HttpOnly');
      response.headers.append('set-cookie', 'neon-auth.session_data=xyz; Path=/; HttpOnly');
      return response;
    });

    const response = await GET(
      new Request('http://x/api/auth/verify-email?token=tok&callbackURL=%2F'),
      context(['verify-email']),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/auth/callback');
    expect(response.headers.getSetCookie()).toEqual([
      'neon-auth.session_token=abc; Path=/; HttpOnly',
      'neon-auth.session_data=xyz; Path=/; HttpOnly',
    ]);
  });

  it('sends a link that no longer works to sign-in, saying which way it failed', async () => {
    getHandler.mockResolvedValue(jsonResponse({ code: 'TOKEN_EXPIRED', message: 'Token expired' }, 401));

    const response = await GET(
      new Request('http://x/api/auth/verify-email?token=old&callbackURL=%2F'),
      context(['verify-email']),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/auth/sign-in?error=TOKEN_EXPIRED');
  });

  it('names no reason when the failure carries no code of its own', async () => {
    getHandler.mockResolvedValue(new Response('gateway timeout', { status: 504 }));

    const response = await GET(
      new Request('http://x/api/auth/verify-email?token=old&callbackURL=%2F'),
      context(['verify-email']),
    );

    expect(response.headers.get('location')).toBe('/auth/sign-in?error=VERIFICATION_FAILED');
  });

  it('leaves a verification asked for from script alone', async () => {
    // `authClient.verifyEmail()` sends no callbackURL because it wants the JSON
    // back. Turning that into a redirect would break the caller.
    getHandler.mockResolvedValue(jsonResponse({ status: true, user: null }));

    const response = await GET(
      new Request('http://x/api/auth/verify-email?token=tok'),
      context(['verify-email']),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true, user: null });
  });
});
