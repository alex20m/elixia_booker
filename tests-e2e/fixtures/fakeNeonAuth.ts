import http from 'node:http';
import { TEST_USER } from './testUser';

/**
 * A stand-in for the managed Neon Auth service, implementing just enough of
 * Better Auth's REST surface — `POST /sign-in/email`, `GET /get-session` and
 * `POST /sign-out` — for the real app's proxy (app/api/auth/[...path]/route.ts)
 * to drive a real sign-in and sign-out end to end, with no external
 * credentials and no dependence on the real service's own uptime.
 *
 * The reason this exists rather than pointing e2e tests at the real thing:
 * PR #107 fixed a bug that only shows up when a get-session check a fresh
 * sign-in makes of itself blips — a real backend won't fail on cue, so a
 * regression test for it needs an upstream that will. The `/__test__/*`
 * control routes below are that cue: a test arms them directly (see
 * tests-e2e/login.spec.ts) before driving the UI, so the failure is scripted
 * and deterministic rather than a flake that may or may not show up on a
 * given run.
 *
 * Run only as Playwright's own webServer subprocess (see playwright.config.ts)
 * — never imported by a spec file. Binding the port is a module-level side
 * effect, so importing this file anywhere else would try to listen a second
 * time and fail with EADDRINUSE against the copy that's already running; a
 * spec that only needs `TEST_USER` imports it from ./testUser instead.
 */

const PORT = Number(process.env.FAKE_NEON_AUTH_PORT ?? 4411);
const COOKIE_NAME = '__Secure-neon-auth.session_token';
const SESSION_TOKEN = 'e2e-session-token';

// A fresh sign-in checks its own session from more than one place at once
// (see the comment on the "still signs in" test), so a fixed "fail the next
// N calls" counter is racy about *which* of those calls the N failures land
// on — fine for scripting a few failures, unusable for asserting nothing
// ever recovers. `outage` sidesteps that: every get-session call fails while
// it's on, with no counting to get wrong.
let pendingGetSessionFailures = 0;
let outage = false;

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const nowIso = () => new Date().toISOString();
const futureIso = () => new Date(Date.now() + 3_600_000).toISOString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Answers 200 so Playwright's webServer readiness probe (a GET to this
  // server's root) succeeds — everything below answers 404 for an unknown
  // path, which the probe does not treat as "ready".
  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__test__/reset') {
    pendingGetSessionFailures = 0;
    outage = false;
    sendJson(res, 200, { ok: true });
    return;
  }

  // Arms the next `count` calls to GET /get-session to answer 502, as if the
  // managed instance had blipped. Calls after that succeed normally again.
  if (req.method === 'POST' && url.pathname === '/__test__/arm-get-session-failures') {
    const body = JSON.parse((await readBody(req)) || '{}') as { count?: number };
    pendingGetSessionFailures = body.count ?? 0;
    sendJson(res, 200, { armed: pendingGetSessionFailures });
    return;
  }

  // Fails every GET /get-session until reset — a sustained outage, not a
  // one-off blip. See the comment on `outage` above for why this is separate
  // from the counter.
  if (req.method === 'POST' && url.pathname === '/__test__/set-get-session-outage') {
    const body = JSON.parse((await readBody(req)) || '{}') as { down?: boolean };
    outage = body.down ?? false;
    sendJson(res, 200, { outage });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/sign-in/email') {
    const body = JSON.parse((await readBody(req)) || '{}') as { email?: string; password?: string };
    if (body.email === TEST_USER.email && body.password === TEST_USER.password) {
      sendJson(
        res,
        200,
        {
          redirect: false,
          token: SESSION_TOKEN,
          user: { id: TEST_USER.id, email: TEST_USER.email, name: 'E2E User', createdAt: nowIso(), updatedAt: nowIso() },
        },
        { 'set-cookie': `${COOKIE_NAME}=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax` },
      );
      return;
    }
    sendJson(res, 401, { error: { message: 'Invalid email or password' } });
    return;
  }

  // The app's own proxy (lib/auth/neonAuth.ts, from @neondatabase/auth)
  // reads this response's Set-Cookie to decide whether to clear its own local
  // "session_data" cookie too (see `mintSessionDataFromResponse` in that
  // package): a deleted session-token cookie — `Max-Age=0` — is what tells it
  // the sign-out actually happened, mirroring Better Auth's own
  // `deleteSessionCookie` (its sign-out route does the same thing before
  // answering `{ success: true }`). Without this, tests-e2e/dashboard.spec.ts's
  // sign-out test would find the session cookie left in place and the
  // dashboard still showing after "signing out".
  if (req.method === 'POST' && url.pathname === '/sign-out') {
    sendJson(res, 200, { success: true }, {
      'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/get-session') {
    if (outage || pendingGetSessionFailures > 0) {
      if (!outage) pendingGetSessionFailures -= 1;
      sendJson(res, 502, { error: { message: 'upstream timed out (scripted for test)' }, code: 'NETWORK_TIMEOUT' });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] !== SESSION_TOKEN) {
      sendJson(res, 200, { session: null, user: null });
      return;
    }

    sendJson(res, 200, {
      session: {
        id: 'e2e-session',
        token: SESSION_TOKEN,
        userId: TEST_USER.id,
        expiresAt: futureIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      user: { id: TEST_USER.id, email: TEST_USER.email, name: 'E2E User', createdAt: nowIso(), updatedAt: nowIso(), emailVerified: true },
    });
    return;
  }

  sendJson(res, 404, { error: { message: `no fake route for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, () => {
  console.log(`[fake-neon-auth] listening on ${PORT}`);
});
