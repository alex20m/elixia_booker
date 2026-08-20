import { neonAuth } from '@/lib/auth/neonAuth';

/**
 * Proxies every Neon Auth request — sign in, sign up, session refresh, email
 * verification, password reset — to the managed Better Auth instance. This is
 * what `authClient` in app/providers.tsx and the auth pages under app/auth/*
 * talk to; the SDK never calls Neon directly from the browser.
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

export const GET = handler?.GET ?? unconfigured;
export const POST = handler?.POST ?? unconfigured;
export const PUT = handler?.PUT ?? unconfigured;
export const DELETE = handler?.DELETE ?? unconfigured;
export const PATCH = handler?.PATCH ?? unconfigured;
