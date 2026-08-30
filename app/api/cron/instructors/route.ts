import { runInstructorSync } from '@/lib/service';
import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Left for the response to be written after the work stops — the same margin
 * the reindex keeps, and for the same reason: a run killed by the platform
 * reports nothing at all.
 */
const SAFETY_MARGIN_MS = 5_000;

/**
 * Nightly, and deliberately separate from `/api/cron/reindex`: refresh every
 * linked account's known instructor names. See `refreshInstructors` in
 * lib/service.ts for why this is its own job rather than a pass inside the
 * reindex.
 */
async function instructors(request: Request): Promise<Response> {
  return handle(async () => {
    // Authorise before touching config: an unauthenticated caller must get a
    // flat 401, not a 500 describing how this deployment is set up.
    await assertCronAuthorised(request);
    const config = loadCronConfig();

    const startedAt = Date.now();
    const refreshed = await runInstructorSync(config, startedAt, {
      deadlineMs: startedAt + maxDuration * 1000 - SAFETY_MARGIN_MS,
    });
    return json({ ok: true, refreshed });
  });
}

export const GET = instructors;
export const POST = instructors;
