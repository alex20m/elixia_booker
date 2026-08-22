import { addSubscription } from '@/lib/service';
import { handle, json, requireConfiguredUser } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    const body = await request.json().catch(() => ({}));
    const subscription = await addSubscription(config, profile, body, nowMs);
    return json({ ok: true, subscription });
  });
}
