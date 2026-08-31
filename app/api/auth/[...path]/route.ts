import { neonAuth } from '@/lib/auth/neonAuth';
import { loadAppConfig } from '@/lib/appConfig';
import { neonSql } from '@/lib/db/neon';
import { createNeonRepo } from '@/lib/db/neonRepo';
import { deleteAccount } from '@/lib/service';

/**
 * Proxies every Neon Auth request — sign in, sign up, session refresh, email
 * verification, password reset, account deletion — to the managed Better
 * Auth instance. This is what `authClient` in app/providers.tsx and the auth
 * pages under app/auth/* talk to; the SDK never calls Neon directly from the
 * browser.
 *
 * Two requests get more done here than the rest, both because Neon Auth is
 * managed remotely and has no hook of its own for the app to run anything
 * from, while this proxy is the one place every request passes through
 * regardless:
 *
 * - **Account deletion** purges the app's own data — profile, subscriptions,
 *   the sealed Elixia secret, history — right after the identity itself is
 *   confirmed gone. See `deleteAccount` in lib/service.ts, and the
 *   housekeeping note at the bottom of db/migrations/0001_initial_schema.sql
 *   this replaces.
 * - **Email verification** is finished here rather than upstream, so the
 *   session it mints survives the trip back to the browser. See
 *   `withVerificationLanding` below for why that is not automatic.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unconfigured = (): Response =>
  new Response(
    JSON.stringify({ error: 'Neon Auth is not configured. Set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET.' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );

const auth = neonAuth();
const handler = auth?.handler();

type RouteContext = { params: Promise<{ path: string[] }> };
type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>;

const isDeleteUser = (path: string[]): boolean => path.length === 1 && path[0] === 'delete-user';
const isDeleteUserCallback = (path: string[]): boolean =>
  path.length === 2 && path[0] === 'delete-user' && path[1] === 'callback';

/**
 * Better Auth's `/delete-user` answers both an immediate deletion and a
 * "verification email sent" request with the same 200 status — only the
 * `message` tells them apart. The `/delete-user/callback` link that confirms
 * a verified deletion redirects on success instead of returning JSON. Both
 * shapes are asserted in better-auth's own OpenAPI metadata for these routes.
 */
async function deletionSucceeded(response: Response): Promise<boolean> {
  if (response.status >= 300 && response.status < 400) return true;
  if (!response.ok) return false;
  try {
    const body = (await response.json()) as { message?: string };
    return body.message === 'User deleted';
  } catch {
    return false;
  }
}

async function purgeAppData(userId: string): Promise<void> {
  const sql = neonSql();
  if (!sql) return; // the in-memory dev fallback has nothing durable to purge
  const config = loadAppConfig({ repo: createNeonRepo(sql) });
  await deleteAccount(config, userId);
}

/** Wraps a proxied handler so a successful deletion purges the app's own data. */
function withAccountPurge(original: RouteHandler, isDeletionPath: (path: string[]) => boolean): RouteHandler {
  return async (request, context) => {
    const { path } = await context.params;
    if (!auth || !isDeletionPath(path)) return original(request, context);

    // Captured before forwarding: a successful deletion clears the session
    // cookie, so the user id is only readable from the request that asked.
    const { data: session } = await auth.getSession();
    const userId = session?.user?.id;

    const response = await original(request, context);
    if (userId && (await deletionSucceeded(response.clone()))) {
      await purgeAppData(userId).catch((err) => {
        console.error('Failed to purge app data after account deletion', err);
      });
    }
    return response;
  };
}

const isVerifyEmail = (path: string[]): boolean => path.length === 1 && path[0] === 'verify-email';

/**
 * Where the browser goes once a verification link has been settled.
 *
 * `/auth/callback` rather than straight to `/`: it is Neon's own view for
 * coming back from an out-of-band flow, and it refetches the session and
 * announces the change before forwarding on, so the app it hands over to
 * already knows who is signed in.
 */
const VERIFIED_LANDING = '/auth/callback';
const VERIFY_FAILED_LANDING = '/auth/sign-in';

/** Better Auth names why it rejected a token; a failure from anywhere else does not. */
async function verificationErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : 'VERIFICATION_FAILED';
  } catch {
    return 'VERIFICATION_FAILED';
  }
}

/**
 * Finishes an email verification here, on this origin, instead of upstream.
 *
 * The link in the verification email carries a `callbackURL`, and Better Auth
 * answers a link that has one with a 302 to it — after setting the session
 * cookie, which is the ordering that makes this fix possible at all. That
 * redirect is the problem: the proxy underneath reaches Neon Auth with a plain
 * `fetch`, `fetch` follows redirects on its own, and the headers of a followed
 * redirect — the `Set-Cookie` among them — are not exposed on the response it
 * finally hands back. So the session was minted, spent inside a server-side
 * fetch, and never reached the browser; the visitor landed back on the app
 * signed out and had to sign in by hand.
 *
 * Taking `callbackURL` off the upstream request is what changes: with nothing
 * to redirect to, Better Auth answers the same verification with a 200 and the
 * cookie still attached, the proxy re-signs it onto this origin as it does for
 * every other auth response, and the redirect the browser needs is issued from
 * here instead — a 303, so it is followed as a GET, carrying the cookies out
 * with it.
 *
 * A verification asked for from script sends no `callbackURL` and wants its
 * JSON back, so it is left exactly as it is.
 */
function withVerificationLanding(original: RouteHandler): RouteHandler {
  return async (request, context) => {
    const { path } = await context.params;
    const url = new URL(request.url);
    if (!auth || !isVerifyEmail(path) || !url.searchParams.has('callbackURL')) {
      return original(request, context);
    }

    url.searchParams.delete('callbackURL');
    const response = await original(new Request(url, request), context);

    const headers = new Headers();
    for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
    headers.set(
      'location',
      response.ok
        ? VERIFIED_LANDING
        : `${VERIFY_FAILED_LANDING}?error=${encodeURIComponent(await verificationErrorCode(response))}`,
    );
    return new Response(null, { status: 303, headers });
  };
}

const isGetSession = (path: string[]): boolean => path.length === 1 && path[0] === 'get-session';

/** A response this proxy's own upstream call reported as a network-level blip, not an answer. */
const isTransientFailure = (response: Response): boolean => response.status >= 500;

/**
 * Retries the one session check every sign-in makes of itself.
 *
 * A fresh sign-in makes this call twice over inside Neon Auth's own handler:
 * once to mint the signed session-data cookie from the new session token, and
 * again when the client refetches its session right afterwards. Either one
 * hitting a one-off blip talking to the managed instance — the kind that
 * clears by the next attempt — comes back as a 502 with no session in it, even
 * though the credentials were correct and the session cookie is already
 * sitting on the response. The sign-in form has no way to tell that apart from
 * a real failure, so it shows the same dead end either way: the password field
 * clears and the visitor is left signed in but looking signed out, until they
 * reload the page by hand or retry and get lucky.
 *
 * A wrong password is a 200 with an empty session, never a 502 — so retrying
 * only on a transient status here can never paper over a real failure, only
 * the network blip the credentials already survived. Scoped to `get-session`
 * alone and to a single retry: this is absorbing one blip, not building a
 * general-purpose retry policy for a proxy that forwards mutations too.
 */
function withSessionRetry(original: RouteHandler): RouteHandler {
  return async (request, context) => {
    const { path } = await context.params;
    if (!isGetSession(path)) return original(request, context);

    const first = await original(request, context);
    if (!isTransientFailure(first)) return first;
    return original(request, context);
  };
}

export const GET = handler
  ? withVerificationLanding(withAccountPurge(withSessionRetry(handler.GET), isDeleteUserCallback))
  : unconfigured;
export const POST = handler ? withAccountPurge(handler.POST, isDeleteUser) : unconfigured;
export const PUT = handler?.PUT ?? unconfigured;
export const DELETE = handler?.DELETE ?? unconfigured;
export const PATCH = handler?.PATCH ?? unconfigured;
