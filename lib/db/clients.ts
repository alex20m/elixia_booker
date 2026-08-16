/**
 * Supabase client construction.
 *
 * Three different clients, because they carry different authority:
 *
 *  - **browser**   — anon key, user's JWT. Row-level security applies.
 *  - **server**    — anon key plus the request's session cookies, used by route
 *                    handlers acting for a signed-in user. RLS applies.
 *  - **service**   — service-role key. Bypasses RLS, so it is used *only* by the
 *                    cron, which legitimately acts for every user at once. It
 *                    must never be reachable from the browser, which is why the
 *                    key has no NEXT_PUBLIC_ prefix.
 */

import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function publicSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/** Browser-side client, for sign-in and sign-up. */
export function createBrowserSupabase(url: string, anonKey: string): SupabaseClient {
  return createBrowserClient(url, anonKey);
}

/**
 * Route-handler client bound to the request's cookies, so Supabase can read the
 * session and refresh it when needed.
 */
export async function createRouteSupabase(): Promise<SupabaseClient | null> {
  const config = publicSupabaseConfig();
  if (!config) return null;

  // Imported lazily so this module stays usable from tests and from the browser
  // bundle, neither of which can resolve next/headers.
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();

  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  }) as unknown as SupabaseClient;
}

/**
 * Service-role client for the cron.
 *
 * Session persistence is off: this runs in a serverless function with no user
 * and no browser, and letting the library try to store a session would be both
 * pointless and a way for one invocation's state to leak into the next.
 */
export function createServiceSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
