/**
 * Turn the calendar feed on or off, for the signed-in user.
 *
 * POST enables it (minting a token on first use, or rotating it when asked)
 * and hands back the token so the page can build the subscribe URL itself —
 * see app/components/CalendarSync.tsx for why that is the browser's job, not
 * this route's. DELETE switches it off without forgetting the token, so
 * turning it back on later does not hand out a different URL.
 *
 * `requireUser` rather than `requireConfiguredUser`, matching
 * /api/telegram/link: the setup wizard offers this as a skippable step before
 * the account is fully configured, so the route has to work there too.
 */

import { enableCalendarSync, disableCalendarSync } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const regenerate = (body as { regenerate?: unknown })?.regenerate === true;

    const updated = await enableCalendarSync(config, profile, { regenerate });
    return json({ enabled: true, token: updated.calendarFeedToken ?? '' });
  });
}

export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const { config, profile } = await requireUser();
    await disableCalendarSync(config, profile);
    return json({ enabled: false });
  });
}
