import { completeSetup, setupState } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The configuration pages a new account goes through before anything else.
 *
 * One of the two routes behind `requireUser` rather than `requireConfiguredUser`
 * — it would be a strange gate that demanded you were already through it. The
 * other is /api/telegram/link, which the notifications page uses to finish.
 *
 * GET answers what the pages need before they can ask anything, and carries no
 * stored answers to prefill: the suggested email is the session's own address,
 * offered on a field the user still has to submit. POST is all-or-nothing, so
 * a rejected submission leaves the account exactly as unconfigured as it was.
 */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const { config, profile, email } = await requireUser();
    return json(setupState(config, profile, email), 200, { 'cache-control': 'no-store' });
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs, email } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const updated = await completeSetup(config, profile, body, nowMs);
    return json(setupState(config, updated, email));
  });
}
