import { centerDefaults, saveCenterDefaults } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

/**
 * Where this user last chose a class from.
 *
 * Its own route rather than part of /api/settings: the settings a user edits
 * on purpose move booking times and are reindexed on every save, while this is
 * a by-product of using the chooser and moves nothing. Folding them together
 * would mean every dropdown change rebuilt the schedule.
 */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const { profile } = await requireUser();
    return json({ defaults: centerDefaults(profile) });
  });
}

export async function PUT(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const updated = await saveCenterDefaults(config, profile, body);
    return json({ defaults: centerDefaults(updated) });
  });
}
