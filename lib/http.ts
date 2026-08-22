/**
 * Shared plumbing for the route handlers.
 *
 * Keeps every route to: authenticate, call a service function, serialise. The
 * error mapping lives here so a thrown ServiceError becomes the right status
 * everywhere, rather than each route inventing its own.
 */

import { loadAppConfig, ConfigError, type AppConfig } from './appConfig';
import { neonAuth } from './auth/neonAuth';
import { neonSql } from './db/neon';
import { createNeonRepo } from './db/neonRepo';
import { getOrCreateProfile, ServiceError } from './service';
import type { Profile } from './types';

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const fail = (message: string, status = 400): Response => json({ error: message }, status);

export interface Session {
  config: AppConfig;
  profile: Profile;
  nowMs: number;
}

/**
 * Resolve the signed-in user, or throw a ServiceError the caller turns into a
 * response. Returning null instead would let a route forget to check.
 *
 * This is the boundary that decides whose data a request may touch: everything
 * downstream works from `profile.id`, and every statement the repo issues is
 * scoped to it. There is no second line of defence in the database — the
 * connection belongs to the app, not to the visitor — so this function is the
 * one place a mistake here would matter.
 */
export async function requireUser(): Promise<Session> {
  const auth = neonAuth();
  if (!auth) {
    throw new ConfigError(
      'Neon Auth is not configured. Set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET.',
    );
  }

  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) throw new ServiceError('Not signed in', 401);

  // No DATABASE_URL is not fatal here: loadAppConfig falls back to the
  // in-memory repo, which keeps `npm run dev` usable before Neon exists. The
  // dashboard warns about it, because that data does not survive.
  const sql = neonSql();
  const config = loadAppConfig(sql ? { repo: createNeonRepo(sql) } : {});
  // The address comes from the session because it is already verified there,
  // and because a user who has to type it in before notifications work is a
  // user whose notifications do not work.
  const email = typeof (user as { email?: unknown }).email === 'string'
    ? (user as { email: string }).email
    : undefined;
  const profile = await getOrCreateProfile(config, user.id, email);

  return { config, profile, nowMs: Date.now() };
}

/** Run a handler, mapping known failures onto statuses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) return fail(err.message, err.status);
    if (err instanceof ConfigError) {
      // Misconfiguration should be obvious and actionable, not a generic 500
      // that sends someone digging through logs.
      return fail(err.message, 500);
    }
    console.error('unhandled route error', err);
    return fail('Something went wrong', 500);
  }
}

/**
 * Config for the cron.
 *
 * The cron has no session — it legitimately acts for every user at once, which
 * is precisely why the endpoint is secret-guarded rather than merely
 * unauthenticated. Unlike `requireUser`, it insists on a real database: a tick
 * that silently booked nothing out of an empty in-memory store would look
 * healthy in the logs while every class went unbooked.
 */
export function loadCronConfig(): AppConfig {
  const sql = neonSql();
  if (!sql) {
    throw new ConfigError('No database is configured. Set DATABASE_URL to your Neon connection string.');
  }
  return loadAppConfig({ repo: createNeonRepo(sql) });
}

/**
 * Guard the cron endpoints.
 *
 * Without this the booking tick would be publicly triggerable, letting anyone
 * fire other people's booking attempts at will.
 *
 * Reads the secret from the environment directly, rather than from an
 * AppConfig, so it can be called *before* anything else. Loading config first
 * would mean an anonymous request gets a 500 describing the deployment's
 * configuration instead of a flat 401 — work done, and internal state
 * disclosed, for a caller that was never authorised.
 */
export function assertCronAuthorised(request: Request, secret = process.env.CRON_SECRET): void {
  if (!secret) {
    throw new ServiceError('CRON_SECRET is not configured on this deployment', 500);
  }
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!timingSafeEqual(provided, secret)) {
    throw new ServiceError('Unauthorized', 401);
  }
}

/**
 * Guard the Telegram webhook.
 *
 * This is the app's only route that answers a caller with no session, so the
 * secret is all there is. Telegram attaches it to every update as
 * `X-Telegram-Bot-Api-Secret-Token`, having been given it once at `setWebhook`
 * time — see SETUP.md.
 *
 * Checked before the body is read, let alone parsed or looked up, so an
 * unauthorised caller costs nothing and learns nothing. A deployment that
 * never configured a secret refuses everyone rather than falling open: the
 * alternative would let anyone bind their own chat to whichever account
 * happened to be part-way through connecting.
 */
export function assertTelegramWebhookAuthorised(
  request: Request,
  secret = process.env.TELEGRAM_WEBHOOK_SECRET,
): void {
  if (!secret) {
    throw new ServiceError('TELEGRAM_WEBHOOK_SECRET is not configured on this deployment', 500);
  }

  const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(provided, secret)) {
    throw new ServiceError('Unauthorized', 401);
  }
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks how many leading characters matched, which is
 * enough to recover it one character at a time given enough attempts.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
