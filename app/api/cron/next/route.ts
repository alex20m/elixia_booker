import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "When does the next release open?" — a read, not a claim.
 *
 * Lets the high-precision watcher (.github/workflows/watch.yml) sleep to the
 * exact release instant using its own clock, instead of depending on a
 * per-minute scheduler trigger to land on time. See that workflow's header
 * comment for why the trigger's own punctuality no longer matters once this
 * exists.
 */
async function next(request: Request): Promise<Response> {
  return handle(async () => {
    // Authorise before touching config: an unauthenticated caller must get a
    // flat 401, not a 500 describing how this deployment is set up.
    assertCronAuthorised(request);
    const config = loadCronConfig();

    const nowMs = Date.now();
    const nextReleaseEpochMs = await config.repo.peekNextRelease(nowMs, nowMs);
    return json({ nextReleaseEpochMs });
  });
}

export const GET = next;
