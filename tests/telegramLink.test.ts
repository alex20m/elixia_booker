import { describe, expect, it } from 'vitest';
import {
  hashLinkToken,
  isValidChatId,
  newLinkToken,
  parseStartCommand,
  telegramDeepLink,
} from '@/lib/telegramLink';

/**
 * The one-tap connect flow, which exists because the old flow asked users to
 * read a chat id out of a JSON document served from a URL containing the
 * operator's bot token.
 *
 * Everything here guards the same property: the *only* thing that ties an
 * incoming Telegram message to an account is the link token. Telegram's own
 * user fields arrive over a public endpoint and are attacker-controlled, so a
 * bug that trusted them would let anyone bind their chat to someone else's
 * profile — and receive that person's gym schedule from then on.
 */

const TOKEN = 'a'.repeat(64);

const startUpdate = (text: string, chatId: unknown = 555): unknown => ({
  update_id: 1,
  message: {
    message_id: 7,
    from: { id: 999, is_bot: false, first_name: 'Someone' },
    chat: { id: chatId, type: 'private' },
    date: 1_700_000_000,
    text,
  },
});

describe('link tokens', () => {
  it('mints tokens too large to guess, and never the same one twice', () => {
    const first = newLinkToken();
    const second = newLinkToken();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('stores a hash, so a database dump cannot be replayed into a link', () => {
    // The token is a bearer secret for the few minutes it lives. What is
    // written down has to be something that proves a presented token without
    // being usable as one.
    const hash = hashLinkToken(TOKEN);

    expect(hash).not.toBe(TOKEN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkToken(TOKEN)).toBe(hash);
    expect(hashLinkToken('b'.repeat(64))).not.toBe(hash);
  });
});

describe('telegramDeepLink', () => {
  it('builds the t.me link that carries the token as the start payload', () => {
    expect(telegramDeepLink('elixia_booker_bot', TOKEN)).toBe(
      `https://t.me/elixia_booker_bot?start=${TOKEN}`,
    );
  });

  it('tolerates the @ people copy along with a bot username', () => {
    expect(telegramDeepLink('@elixia_booker_bot', TOKEN)).toBe(
      `https://t.me/elixia_booker_bot?start=${TOKEN}`,
    );
  });
});

describe('parseStartCommand', () => {
  it('reads the chat to reply to and the token that identifies the account', () => {
    expect(parseStartCommand(startUpdate(`/start ${TOKEN}`))).toEqual({
      chatId: '555',
      token: TOKEN,
    });
  });

  it('binds the chat the message came from, not the user id it claims', () => {
    // `from.id` and `chat.id` coincide in a private chat, so a mix-up here
    // passes every manual test and then delivers to the wrong place — or to
    // nowhere — the first time they differ.
    const parsed = parseStartCommand(startUpdate(`/start ${TOKEN}`, 555));

    expect(parsed?.chatId).toBe('555');
    expect(parsed?.chatId).not.toBe('999');
  });

  it('accepts the /start@botname form Telegram sends from group chats', () => {
    expect(parseStartCommand(startUpdate(`/start@elixia_bot ${TOKEN}`))?.token).toBe(TOKEN);
  });

  it('ignores a bare /start, which carries no claim about who sent it', () => {
    expect(parseStartCommand(startUpdate('/start'))).toBeNull();
  });

  it('ignores a payload that is not shaped like one of our tokens', () => {
    // Rejecting at the edge keeps junk and injection attempts away from the
    // lookup entirely, rather than relying on it to find no row.
    expect(parseStartCommand(startUpdate("/start '; drop table profiles; --"))).toBeNull();
    expect(parseStartCommand(startUpdate('/start ' + 'A'.repeat(64)))).toBeNull();
    expect(parseStartCommand(startUpdate('/start ' + 'a'.repeat(63)))).toBeNull();
  });

  it('ignores ordinary chatter and updates that are not messages at all', () => {
    expect(parseStartCommand(startUpdate('hello'))).toBeNull();
    expect(parseStartCommand({ update_id: 2, callback_query: { id: 'x' } })).toBeNull();
    expect(parseStartCommand({})).toBeNull();
    expect(parseStartCommand(null)).toBeNull();
    expect(parseStartCommand('not an object')).toBeNull();
  });

  it('survives a message with no chat, rather than throwing inside the webhook', () => {
    expect(parseStartCommand({ message: { text: `/start ${TOKEN}` } })).toBeNull();
  });
});

describe('isValidChatId', () => {
  it('accepts the numeric ids Telegram issues, including negative group ids', () => {
    expect(isValidChatId('555')).toBe(true);
    expect(isValidChatId('-1001234567890')).toBe(true);
  });

  it('rejects an @channel handle, which would post the user’s schedule publicly', () => {
    expect(isValidChatId('@some_public_channel')).toBe(false);
  });

  it('rejects blanks and anything that is not a plain number', () => {
    expect(isValidChatId('')).toBe(false);
    expect(isValidChatId('12 34')).toBe(false);
    expect(isValidChatId('1e9')).toBe(false);
    expect(isValidChatId('9'.repeat(30))).toBe(false);
  });
});
