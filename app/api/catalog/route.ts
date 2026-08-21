import { listCenters, listClasses } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

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
      return json({ centers: await listCenters(config, profile, nowMs) });
    }
    return json({ classes: await listClasses(config, profile, center, nowMs) });
  });
}
