/**
 * Connecting a Telegram chat to an account, in one tap.
 *
 * The problem this solves: a bot cannot start a conversation. Telegram only
 * tells you a chat id once the user has messaged the bot, which is why the
 * old setup asked people to send a message and then read `message.chat.id` out
 * of `getUpdates` — a URL with the operator's bot token in its path. That does
 * not scale past one user without handing out the token.
 *
 * Instead: the app mints a short-lived token, puts it in a t.me deep link, and
 * the user taps Start. Telegram delivers `/start <token>` to the webhook, and
 * the token — not anything Telegram says about the sender — is what identifies
 * the account. That matters because the webhook is a public endpoint: every
 * field in an update is attacker-controlled, so binding on `message.from`
 * would let anyone claim any profile.
 *
 * One tap is the floor, not a shortcoming of this design. The Login Widget
 * looks like it avoids it, but a chat you have never started cannot be sent to.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * How long a link token stays usable.
 *
 * Long enough to switch apps, find the bot and tap Start; short enough that a
 * token left in a browser tab, a shared screen or a chat log is inert by the
 * time anyone else could use it.
 */
export const LINK_TOKEN_TTL_MS = 10 * 60_000;

/** 32 bytes of randomness, hex-encoded: unguessable within its lifetime. */
export function newLinkToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * What gets stored for a pending link.
 *
 * A token is a bearer credential while it lives, so the database holds only a
 * hash of it: a dump — or a read-only leak — then proves nothing and cannot be
 * presented to the webhook. No salt and no stretching, deliberately: the input
 * is 256 bits of uniform randomness, so there is no dictionary to run and
 * nothing for a work factor to buy.
 */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The shape a valid token has, checked before anything looks one up. */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * `/start <token>`, optionally addressed as `/start@thebot <token>`, which is
 * the form Telegram delivers when the bot is spoken to from a group.
 */
const START_PATTERN = /^\/start(?:@[A-Za-z0-9_]+)?\s+([0-9a-f]{64})$/;

/** The deep link behind the Connect button. */
export function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?start=${token}`;
}

export interface StartCommand {
  /** The chat to bind and reply to. */
  chatId: string;
  /** The link token presented, already known to be well-formed. */
  token: string;
}

/**
 * Pull a connect attempt out of a Telegram update, or decide it is not one.
 *
 * Returns null rather than throwing for everything else the bot receives —
 * ordinary chatter, edits, callback queries, malformed bodies — because the
 * webhook answers all of those with 200 and no action. A throw there would be
 * a 500, and Telegram retries 500s.
 */
export function parseStartCommand(update: unknown): StartCommand | null {
  if (typeof update !== 'object' || update === null) return null;

  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;

  const { text, chat } = message as { text?: unknown; chat?: unknown };
  if (typeof text !== 'string') return null;

  // The chat, never `from`: the reply has to go to the conversation the
  // message arrived in, and the sender's own id is not that.
  if (typeof chat !== 'object' || chat === null) return null;
  const chatId = (chat as { id?: unknown }).id;
  if (typeof chatId !== 'number' && typeof chatId !== 'string') return null;

  const match = START_PATTERN.exec(text.trim());
  if (!match) return null;

  return { chatId: String(chatId), token: match[1]! };
}

/**
 * Parse a raw request body into a connect attempt, or decide it is not one.
 *
 * Takes text rather than a parsed object because a public endpoint gets sent
 * bodies that are not JSON at all, and `JSON.parse` throwing inside the route
 * would become a 500 — which Telegram would then retry, indefinitely.
 */
export function parseStartCommandFromBody(raw: string): StartCommand | null {
  try {
    return parseStartCommand(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Whether a string is a chat id Telegram could have issued.
 *
 * Only used by the manual fallback, for deployments that have not set up a
 * webhook. Negative ids are real — groups and channels have them — but an
 * `@handle` is not accepted: Telegram would resolve it to a public channel,
 * and the user's schedule would be posted where anyone can read it.
 */
export function isValidChatId(value: string): boolean {
  return /^-?\d{1,19}$/.test(value);
}

export { TOKEN_PATTERN };
