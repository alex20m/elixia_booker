import { runReindex } from '@/lib/service';
import { assertCronAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Nightly: reproject every linked account's classes and drop releases long
 * past, so the per-minute tick stays a single indexed range scan.
 */
async function reindex(request: Request): Promise<Response> {
  return handle(async () => {
    // Authorise before touching config: an unauthenticated caller must get a
    // flat 401, not a 500 describing how this deployment is set up.
    assertCronAuthorised(request);
    const config = loadCronConfig();

    const indexed = await runReindex(config);
    return json({ ok: true, indexed });
  });
}

export const GET = reindex;
export const POST = reindex;
