import { buildDashboard } from '@/lib/service';
import { handle, json, requireConfiguredUser } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    return json(await buildDashboard(config, profile, nowMs));
  });
}
