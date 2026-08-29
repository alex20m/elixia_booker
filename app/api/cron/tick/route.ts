import { runDueBookings } from '@/lib/service';
import { TICK_MAX_DURATION_SECONDS } from '@/lib/qstash';
import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Vercel's ceiling for this function. Hobby allows up to 60s; Pro up to 300s.
 * Raising it on Pro widens the usable retry window for a release landing late
 * in the minute — see the deadline handling below.
 *
 * Taken from lib/qstash.ts rather than written here, because the timeout the
 * scheduler puts on every published message is sized against this number. Two
 * copies would let the route shrink its own budget without anything noticing.
 */
export const maxDuration = TICK_MAX_DURATION_SECONDS;

/** Leave room to write history and return before the platform pulls the plug. */
const SAFETY_MARGIN_MS = 5_000;

/**
 * The booking tick. Fired by the booking watcher (see
 * .github/workflows/watch.yml), which sleeps to the exact release instant
 * using its own clock rather than depending on a scheduler's punctuality.
 *
 * GET and POST both work so any caller can drive it.
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
