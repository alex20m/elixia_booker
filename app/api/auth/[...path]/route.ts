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
 * Account deletion gets one thing more done here than everything else routed
 * through this proxy: Neon Auth is managed remotely, so there is no hook of
 * its own for the app to run cleanup from. This proxy is the one place every
 * deletion request passes through regardless, so it purges the app's own
 * data — profile, subscriptions, the sealed Elixia secret, history — right
 * after the identity itself is confirmed gone. See `deleteAccount` in
 * lib/service.ts, and the housekeeping note at the bottom of
 * db/migrations/0001_initial_schema.sql this replaces.
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

export const GET = handler ? withAccountPurge(handler.GET, isDeleteUserCallback) : unconfigured;
export const POST = handler ? withAccountPurge(handler.POST, isDeleteUser) : unconfigured;
export const PUT = handler?.PUT ?? unconfigured;
export const DELETE = handler?.DELETE ?? unconfigured;
export const PATCH = handler?.PATCH ?? unconfigured;
