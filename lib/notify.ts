/**
 * Where a booking result goes, and how it gets there.
 *
 * Notification failure must never mask a booking result: if the channel is
 * down, the booking still happened and the log is still the record. So every
 * send is best-effort and returns a status rather than throwing — see
 * lib/deliver.ts, which holds that guarantee along with the deadline and the
 * secret-scrubbing both channels need.
 *
 * `notifyUser` is the entry point; `notifyChat` and `sendEmail` are the two
 * transports underneath it. Nothing above this module should have to know
 * which channel a given user is on.
 */

import { postJson, type DeliverOptions, type NotifyResult } from './deliver';
import { sendEmail } from './email';
import type { NotifyChannel, Profile } from './types';

export type { NotifyResult } from './deliver';

/** Telegram's own limit; messages beyond it are rejected outright. */
const TELEGRAM_MAX_CHARS = 4096;

/** Email subject lines are one line, and long ones get truncated by clients. */
const SUBJECT_MAX_CHARS = 120;

export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  const suffix = '\n…[truncated]';
  return text.slice(0, TELEGRAM_MAX_CHARS - suffix.length) + suffix;
}

/**
 * Send to one user's chat.
 *
 * The bot token is the operator's; the chat id is the user's own, learned from
 * the connect flow. A user without one simply gets no notifications — that must
 * never be an error, since it would otherwise fail a booking run that succeeded.
 */
export async function notifyChat(
  botToken: string | undefined,
  chatId: string | undefined,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<NotifyResult> {
  if (!botToken || !chatId) {
    return { sent: false, reason: 'no bot token or no chat id configured' };
  }

  return postJson(
    {
      url: `https://api.telegram.org/bot${botToken}/sendMessage`,
      headers: {},
      body: {
        chat_id: chatId,
        text: truncateForTelegram(text),
        // Deliberately not using parse_mode: class names and error bodies are
        // arbitrary text, and an unescaped underscore would make Telegram
        // reject the whole message — losing the alert to a formatting detail.
        disable_web_page_preview: true,
      },
      service: 'telegram',
      // The token is in the URL, so anything quoting the request quotes it.
      secrets: [botToken],
    },
    { fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
}

/** The operator-side configuration the channels need. `AppConfig` satisfies it. */
export interface NotifyConfig {
  telegramBotToken?: string;
  resendApiKey?: string;
  notifyFromEmail?: string;
}

/** The parts of a profile that decide where a message goes. */
export type NotifyTarget = Pick<Profile, 'notifyChannel' | 'notifyEmail' | 'telegramChatId'>;

/**
 * The channel a profile is on, or nothing at all.
 *
 * There is deliberately no fallback. An absent channel means the account has
 * not been through setup, and picking one on its behalf here would defeat the
 * point of asking: whichever this function guessed would then be the app's
 * default, however loudly the setup pages insisted there wasn't one.
 */
export function channelFor(profile: NotifyTarget): NotifyChannel | undefined {
  return profile.notifyChannel;
}

/**
 * The subject line for an emailed alert.
 *
 * The message is already a one-line summary, so the subject is that line: an
 * alert whose subject reads "Booking update" makes the reader open it to learn
 * what every Telegram user could see from the notification shade.
 */
export function subjectFor(text: string): string {
  const firstLine = text.split('\n')[0]!.trim();
  if (!firstLine) return 'Elixia booker';
  return firstLine.length <= SUBJECT_MAX_CHARS
    ? firstLine
    : `${firstLine.slice(0, SUBJECT_MAX_CHARS - 1)}…`;
}

/**
 * Send one alert to whichever channel the user chose.
 *
 * Note what this deliberately does *not* do: fall back. A user on Telegram who
 * has not finished connecting gets nothing, rather than having their gym
 * schedule quietly rerouted to an inbox they never nominated for it. The
 * unsent reason says which, and the caller logs it — silence with a recorded
 * cause is recoverable, silence without one is a support ticket.
 */
export async function notifyUser(
  config: NotifyConfig,
  profile: NotifyTarget,
  text: string,
  options: DeliverOptions = {},
): Promise<NotifyResult> {
  const channel = channelFor(profile);
  if (!channel) {
    return { sent: false, reason: 'this account has not chosen a notification channel yet' };
  }

  switch (channel) {
    case 'none':
      return { sent: false, reason: 'notifications are switched off for this user' };

    case 'telegram':
      return notifyChat(
        config.telegramBotToken,
        profile.telegramChatId,
        text,
        options.fetchImpl ?? fetch,
        options.timeoutMs,
      );

    case 'email':
      return sendEmail(
        {
          ...(config.resendApiKey ? { resendApiKey: config.resendApiKey } : {}),
          ...(config.notifyFromEmail ? { notifyFromEmail: config.notifyFromEmail } : {}),
          ...(profile.notifyEmail ? { to: profile.notifyEmail } : {}),
          subject: subjectFor(text),
          text,
        },
        options,
      );
  }
}
