import { buildDashboard } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireUser();
    return json(await buildDashboard(config, profile, nowMs));
  });
}
