/**
 * The calendar feed itself — fetched by a calendar app, not a browser tab.
 *
 * No session guards this: a calendar app cannot carry Neon Auth's cookie, so
 * the token in the URL is the only credential there is (see
 * `Profile.calendarFeedToken`). Every reason the feed might not be servable —
 * an unknown token, sync switched off, an unfinished setup — is collapsed
 * into the same 404 by `calendarFeedFor`, so nothing here narrows that back
 * down for a caller probing the URL.
 */

import { calendarFeedFor } from '@/lib/service';
import { loadCalendarFeedConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token: raw } = await params;
  // Calendar apps and browsers alike are happier with a URL that ends
  // `.ics`; the token itself is the part that has to match.
  const token = raw.replace(/\.ics$/i, '');

  const config = loadCalendarFeedConfig();
  const feed = await calendarFeedFor(config, token, Date.now());
  if (!feed) return new Response('Not found', { status: 404 });

  return new Response(feed, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
