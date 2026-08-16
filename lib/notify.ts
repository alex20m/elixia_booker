/**
 * Telegram notifications.
 *
 * Notification failure must never mask a booking result: if Telegram is down,
 * the booking still happened and the log is still the record. So every send is
 * best-effort and returns a status rather than throwing.
 */


export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

/** Telegram's own limit; messages beyond it are rejected outright. */
const TELEGRAM_MAX_CHARS = 4096;

export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  const suffix = '\n…[truncated]';
  return text.slice(0, TELEGRAM_MAX_CHARS - suffix.length) + suffix;
}

/**
 * Send to one user's chat.
 *
 * The bot token is the operator's; the chat id is the user's own, supplied in
 * settings. A user without one simply gets no notifications — that must never
 * be an error, since it would otherwise fail a booking run that succeeded.
 */
export async function notifyChat(
  botToken: string | undefined,
  chatId: string | undefined,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const token = botToken;

  if (!token || !chatId) {
    return { sent: false, reason: 'no bot token or no chat id configured' };
  }

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncateForTelegram(text),
        // Deliberately not using parse_mode: class names and error bodies are
        // arbitrary text, and an unescaped underscore would make Telegram
        // reject the whole message — losing the alert to a formatting detail.
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      return { sent: false, reason: `telegram returned HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `telegram request failed: ${(err as Error).message}` };
  }
}
