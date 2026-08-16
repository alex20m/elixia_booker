/**
 * Shared plumbing for the route handlers.
 *
 * Keeps every route to: authenticate, call a service function, serialise. The
 * error mapping lives here so a thrown ServiceError becomes the right status
 * everywhere, rather than each route inventing its own.
 */

import { loadAppConfig, ConfigError, type AppConfig } from './appConfig';
import { createRouteSupabase, createServiceSupabase } from './db/clients';
import { createSupabaseRepo } from './db/supabaseRepo';
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
 * The repo is built from the *request-scoped* Supabase client, so every query
 * carries the user's JWT and row-level security applies. A bug that passed the
 * wrong user id would still return nothing.
 */
export async function requireUser(): Promise<Session> {
  const supabase = await createRouteSupabase();
  if (!supabase) {
    throw new ConfigError(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ServiceError('Not signed in', 401);

  const config = loadAppConfig({ repo: createSupabaseRepo(supabase) });
  const profile = await getOrCreateProfile(config, data.user.id);

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
 * Config for the cron, backed by the service-role client.
 *
 * The cron legitimately acts for every user at once, so it bypasses row-level
 * security. That is precisely why the endpoint is secret-guarded.
 */
export function loadCronConfig(): AppConfig {
  const supabase = createServiceSupabase();
  if (!supabase) {
    throw new ConfigError(
      'Supabase service role is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return loadAppConfig({ repo: createSupabaseRepo(supabase) });
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
