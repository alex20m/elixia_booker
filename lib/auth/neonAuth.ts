import { createNeonAuth, type NeonAuth } from '@neondatabase/auth/next/server';

/**
 * Neon Auth, which is managed Better Auth wearing Neon's badge.
 *
 * It owns identity — passwords, email verification, password reset, sessions —
 * and stores users directly in the `neon_auth` schema of the same Neon database
 * the app writes to. Nothing here reads that schema: the app only ever needs
 * the user id, which arrives with the session, and joining against it would
 * make a fresh signup look like a missing user if the two databases (they are
 * the same one here, but the client only knows the session) ever drifted.
 *
 * Identity stays deliberately separate from the *gym* account (see
 * lib/service.ts). Sign-in must not depend on Elixia, whose login flow has
 * never been observed and may well be 2FA-gated or an OAuth redirect.
 */

const COOKIE_SECRET_MIN_LENGTH = 32;

/** Whether Neon Auth is configured. The sign-in page says so plainly if not. */
export function authConfigured(): boolean {
  return Boolean(
    process.env.NEON_AUTH_BASE_URL &&
      (process.env.NEON_AUTH_COOKIE_SECRET?.length ?? 0) >= COOKIE_SECRET_MIN_LENGTH,
  );
}

let cached: NeonAuth | null = null;

/**
 * The server-side Neon Auth instance, or null when Neon Auth is not configured.
 *
 * Constructed lazily: the constructor throws when the cookie secret is missing
 * or too short, and a deployment that is merely half-configured should render
 * a page explaining that rather than failing to boot.
 */
export function neonAuth(): NeonAuth | null {
  if (!authConfigured()) return null;

  cached ??= createNeonAuth({
    baseUrl: process.env.NEON_AUTH_BASE_URL!,
    cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
  });

  return cached;
}
