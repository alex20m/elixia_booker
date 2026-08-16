import { linkElixia, unlinkElixia } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

/** Link a gym account: verify the credentials, then store them sealed. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireUser();
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };

    await linkElixia(config, profile, body.email ?? '', body.password ?? '', nowMs);
    return json({ ok: true });
  });
}

/** Forget the stored credentials entirely. */
export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireUser();
    await unlinkElixia(config, profile, nowMs);
    return json({ ok: true });
  });
}
