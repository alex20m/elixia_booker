import { runDueBookings } from '@/lib/service';
import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Vercel's ceiling for this function. Hobby allows up to 60s; Pro up to 300s.
 * Raising it on Pro widens the usable retry window for a release landing late
 * in the minute — see the deadline handling below.
 */
export const maxDuration = 60;

/** Leave room to write history and return before the platform pulls the plug. */
const SAFETY_MARGIN_MS = 5_000;

/**
 * The booking tick. Driven every minute by GitHub Actions (see
 * .github/workflows/cron.yml), which is free and has minute granularity —
 * unlike Vercel's Hobby cron, which fires only once a day.
 *
 * GET and POST both work so any scheduler can drive it.
 */
async function tick(request: Request): Promise<Response> {
  return handle(async () => {
    // Authorise before touching config: an unauthenticated caller must get a
    // flat 401, not a 500 describing how this deployment is set up.
    assertCronAuthorised(request);
    const config = loadCronConfig();

    const startedAt = Date.now();
    const handled = await runDueBookings(config, startedAt, {
      deadlineMs: startedAt + maxDuration * 1000 - SAFETY_MARGIN_MS,
    });

    return json({ ok: true, handled, tookMs: Date.now() - startedAt });
  });
}

export const GET = tick;
export const POST = tick;
