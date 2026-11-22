import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Keeping a signed-in browser signed in, through the real Neon Auth handler.
 *
 * Better Auth keeps a session alive by re-issuing the session-token cookie
 * with a fresh expiry from `get-session` once the session is due a refresh.
 * Neon Auth's handler answers `get-session` from its own signed cache cookie
 * whenever it can — and when that cache has lapsed, it re-fetches the session
 * upstream but throws the upstream `Set-Cookie` away. The renewed expiry never
 * reached the browser, so the cookie it held still expired on the date it was
 * first set: signed out a fixed time after signing in, however often the app
 * was used.
 *
 * Only the upstream service is faked here, at the network boundary; the route
 * and the package's handler underneath it are the real ones.
 */

const UPSTREAM = 'https://auth.test/neondb/auth';
const TOKEN_COOKIE = '__Secure-neon-auth.session_token';
const CACHE_COOKIE = '__Secure-neon-auth.local.session_data';
const TOKEN = 'live-session-token';
const RENEWED_MAX_AGE = 604800;

const upstreamCalls: string[] = [];

function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  upstreamCalls.push(url.pathname);
  const cookie = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('cookie') ?? '';

  if (url.pathname !== '/neondb/auth/get-session') {
    return Promise.resolve(Response.json({ error: 'no fake route' }, { status: 404 }));
  }
  if (!cookie.includes(`${TOKEN_COOKIE}=${TOKEN}`)) {
    return Promise.resolve(Response.json(null));
  }
  const now = new Date();
  const headers = new Headers({ 'content-type': 'application/json' });
  // What Better Auth sends when it slides the session forward.
  headers.append(
    'set-cookie',
    `${TOKEN_COOKIE}=${TOKEN}; Path=/; Max-Age=${RENEWED_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
  );
  return Promise.resolve(
    new Response(
      JSON.stringify({
        session: {
          id: 's1',
          token: TOKEN,
          userId: 'u1',
          expiresAt: new Date(now.getTime() + RENEWED_MAX_AGE * 1000).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        user: {
          id: 'u1',
          email: 'member@example.com',
          name: 'Member',
          emailVerified: true,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      }),
      { status: 200, headers },
    ),
  );
}

const context = { params: Promise.resolve({ path: ['get-session'] }) };

const getSession = async (cookie: string): Promise<Response> => {
  const { GET } = await import('@/app/api/auth/[...path]/route');
  return GET(new Request('https://app.test/api/auth/get-session', { headers: { cookie } }), context);
};

const setCookieNamed = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

beforeEach(() => {
  vi.resetModules();
  upstreamCalls.length = 0;
  vi.stubEnv('NEON_AUTH_BASE_URL', UPSTREAM);
  vi.stubEnv('NEON_AUTH_COOKIE_SECRET', 'x'.repeat(48));
  vi.stubGlobal('fetch', vi.fn(fakeUpstream));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/auth/get-session once the session cache has lapsed', () => {
  it('passes the renewed session cookie on to the browser, so an app in use stays signed in', async () => {
    const response = await getSession(`${TOKEN_COOKIE}=${TOKEN}`);

    expect(response.status).toBe(200);
    expect(setCookieNamed(response, TOKEN_COOKIE)).toContain(`Max-Age=${RENEWED_MAX_AGE}`);
    expect((await response.json()).user.id).toBe('u1');
  });

  it('still refreshes the session cache alongside it', async () => {
    const response = await getSession(`${TOKEN_COOKIE}=${TOKEN}`);

    expect(setCookieNamed(response, CACHE_COOKIE)).toMatch(/Max-Age=\d+/);
  });
});

describe('GET /api/auth/get-session while the session cache is still fresh', () => {
  it('answers from the cache without calling upstream', async () => {
    const first = await getSession(`${TOKEN_COOKIE}=${TOKEN}`);
    const cache = setCookieNamed(first, CACHE_COOKIE)!.split(';')[0];
    upstreamCalls.length = 0;

    const response = await getSession(`${TOKEN_COOKIE}=${TOKEN}; ${cache}`);

    expect((await response.json()).user.id).toBe('u1');
    expect(upstreamCalls).toEqual([]);
  });
});

describe('GET /api/auth/get-session without a session', () => {
  it('reports no session and sets no cookie', async () => {
    const response = await getSession('');

    expect(await response.json()).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
