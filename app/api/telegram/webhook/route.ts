/**
 * Where Telegram tells us a user tapped Start.
 *
 * Public by necessity: Telegram has no session and cannot acquire one, so this
 * route is reachable by anyone who finds the URL. Two things stand in their
 * way — the shared secret Telegram echoes on every call, and the link token
 * inside the message, which is the only thing that names an account. Nothing
 * here trusts a field describing the sender; see lib/telegramLink.ts.
 *
 * Everything it cannot act on is answered 200 and dropped. Telegram retries
 * 5xx responses, so a route that raised on malformed input would convert one
 * junk request into an indefinite retry loop against the database.
 */

import { completeTelegramLink } from '@/lib/service';
import { notifyChat } from '@/lib/notify';
import { parseStartCommandFromBody } from '@/lib/telegramLink';
import { assertTelegramWebhookAuthorised, handle, json, loadCronConfig } from '@/lib/http';

export const runtime = 'nodejs';

/**
 * Well above any real update — Telegram's are a few kilobytes — and far below
 * anything that would cost real memory to parse. A public endpoint should not
 * accept a body it has no use for.
 */
const MAX_BODY_BYTES = 64 * 1024;

const LINKED_MESSAGE =
  '✅ Connected. Booking alerts will arrive here from now on. ' +
  'You can switch back to email any time in Settings.';

const EXPIRED_MESSAGE =
  '⚠️ That connect link has expired or was already used. ' +
  'Open Settings in the app and tap Connect Telegram again.';

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    // First, before the body is touched: an unauthorised caller must not be
    // able to make this route do any work at all.
    assertTelegramWebhookAuthorised(request);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'Update too large' }, 413);
    }

    const start = parseStartCommandFromBody(raw);
    // Not a connect attempt: chatter, an edit, a callback, or nonsense. Telegram
    // is told we are done with it either way.
    if (!start) return json({ ok: true });

    const config = loadCronConfig();
    const outcome = await completeTelegramLink(config, start.token, start.chatId, Date.now());

    // Best-effort, like every other notification: the binding has already been
    // written, and a failure to say so must not make Telegram retry an update
    // that succeeded.
    await notifyChat(
      config.telegramBotToken,
      start.chatId,
      outcome === 'linked' ? LINKED_MESSAGE : EXPIRED_MESSAGE,
    );

    return json({ ok: true });
  });
}
