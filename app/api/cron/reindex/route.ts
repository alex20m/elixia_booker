import { runReindex } from '@/lib/service';
import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Left for the response to be written after the work stops — the same margin
 * the booking tick keeps, and for the same reason: a run killed by the
 * platform reports nothing at all.
 */
const SAFETY_MARGIN_MS = 5_000;

/**
 * Nightly: reproject every linked account's classes and drop releases long
 * past, so the booking watcher's lookups stay a single indexed range scan.
 */
async function reindex(request: Request): Promise<Response> {
  return handle(async () => {
    // Authorise before touching config: an unauthenticated caller must get a
    // flat 401, not a 500 describing how this deployment is set up.
    await assertCronAuthorised(request);
    const config = loadCronConfig();

    const startedAt = Date.now();
    const indexed = await runReindex(config, startedAt, {
      deadlineMs: startedAt + maxDuration * 1000 - SAFETY_MARGIN_MS,
    });
    return json({ ok: true, indexed });
  });
}

export const GET = reindex;
export const POST = reindex;
