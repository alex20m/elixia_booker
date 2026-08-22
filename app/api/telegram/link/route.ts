/**
 * Start or undo a Telegram connection, for the signed-in user.
 *
 * POST mints the deep link behind the Connect button; DELETE forgets a chat
 * that was connected. The webhook next door handles the other side — the part
 * that arrives from Telegram, unauthenticated, once the user taps Start.
 */

import { disconnectTelegram, startTelegramLink } from '@/lib/service';
import { handle, json, requireUser } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireUser();
    const { url, expiresAtMs } = await startTelegramLink(config, profile, nowMs);

    // The expiry goes back with the link so the page can say the tap has to
    // happen soon, rather than leaving someone to discover it silently failed.
    return json({ url, expiresAt: new Date(expiresAtMs).toISOString() });
  });
}

export async function DELETE(): Promise<Response> {
  return handle(async () => {
    const { config, profile } = await requireUser();
    await disconnectTelegram(config, profile);
    return json({ ok: true });
  });
}
