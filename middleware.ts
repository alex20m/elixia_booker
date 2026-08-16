import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Keeps the Supabase session alive.
 *
 * Access tokens are short-lived. Without a refresh on each navigation, a user
 * who left the tab open comes back signed out — and, worse, the booking cron is
 * unaffected while the UI silently claims nothing is configured. Refreshing
 * here means the browser and the database agree about who is signed in.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Not configured yet: the page itself explains what to set.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what triggers the refresh; the result is unused here.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Everything except static assets and the cron endpoints, which authenticate
  // with a shared secret rather than a user session.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/cron).*)'],
};
