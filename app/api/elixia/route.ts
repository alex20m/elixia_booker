import { linkElixia, unlinkElixia, updateElixiaCredentials } from '@/lib/service';
import { handle, json, requireConfiguredUser } from '@/lib/http';

export const runtime = 'nodejs';

/** Link a gym account: verify the credentials, then store them sealed. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };

    await linkElixia(config, profile, body.email ?? '', body.password ?? '', nowMs);
    return json({ ok: true });
  });
}

/**
 * Change the credentials of the account already linked.
 *
 * Separate from POST rather than folded into it, because the two differ in
 * what an absent field means: POST is given both, PATCH treats an omitted
 * password as "keep the stored one" so an address can be corrected without
 * retyping it. Doing this by DELETE-then-POST would drop the queued bookings
 * in between.
 */
export async function PATCH(request: Request): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };

    await updateElixiaCredentials(
      config,
      profile,
      {
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.password === 'string' ? { password: body.password } : {}),
      },
      nowMs,
    );
    return json({ ok: true });
  });
}

/** Forget the stored credentials entirely. */
export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    await unlinkElixia(config, profile, nowMs);
    return json({ ok: true });
  });
}
