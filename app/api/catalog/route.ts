import { listCenters, listClasses } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';
// Matches every other route here, and matters more on this one: without it a
// centre list could be served from Vercel's CDN, and a club Elixia added this
// morning would stay invisible until the cache turned over.
export const dynamic = 'force-dynamic';

/** Keeps the browser and any proxy out of it too. */
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * What the class chooser is built from: Elixia's own centres, and the weekly
 * slots one centre publishes.
 *
 * Two shapes behind one route because they are one question asked twice —
 * "what can I pick here?" — and the answer is always read straight from the
 * live schedule rather than from anything this app stores. Nothing is cached:
 * a timetable that changed this morning has to be what the chooser offers this
 * afternoon, or it starts offering classes that no longer run.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireUser();
    const center = new URL(request.url).searchParams.get('center');

    if (center === null) {
      return json({ centers: await listCenters(config, profile, nowMs) }, 200, NO_STORE);
    }
    return json({ classes: await listClasses(config, profile, center, nowMs) }, 200, NO_STORE);
  });
}
