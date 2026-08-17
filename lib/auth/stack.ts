import { StackServerApp } from '@stackframe/stack';

/**
 * Neon Auth, which is Stack Auth wearing Neon's badge.
 *
 * It owns identity — passwords, email verification, password reset, sessions —
 * and mirrors its users into `neon_auth.users_sync` in the same Neon database
 * the app writes to. Nothing here reads that mirror: the app only ever needs
 * the user id, which arrives with the session, and joining against a table
 * populated asynchronously would make a fresh signup look like a missing user.
 *
 * Identity stays deliberately separate from the *gym* account (see
 * lib/service.ts). Sign-in must not depend on Elixia, whose login flow has
 * never been observed and may well be 2FA-gated or an OAuth redirect.
 */

const KEYS = [
  'NEXT_PUBLIC_STACK_PROJECT_ID',
  'NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY',
  'STACK_SECRET_SERVER_KEY',
] as const;

/** Whether Neon Auth is configured. The sign-in page says so plainly if not. */
export function authConfigured(): boolean {
  return KEYS.every((key) => Boolean(process.env[key]));
}

let cached: StackServerApp<true> | null = null;

/**
 * The server-side Stack app, or null when Neon Auth is not configured.
 *
 * Constructed lazily: the constructor throws on missing keys, and a deployment
 * that is merely half-configured should render a page explaining that rather
 * than failing to boot.
 *
 * `tokenStore: 'nextjs-cookie'` is what makes the session readable from route
 * handlers and server components — the tokens live in cookies, refreshed by the
 * SDK, so there is no session middleware to keep in step.
 */
export function stackServerApp(): StackServerApp<true> | null {
  if (!authConfigured()) return null;

  cached ??= new StackServerApp({
    tokenStore: 'nextjs-cookie',
    urls: {
      signIn: '/handler/sign-in',
      afterSignIn: '/',
      afterSignUp: '/',
      afterSignOut: '/',
    },
  });

  return cached;
}
