'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';

/**
 * The Connect-Telegram control, shared by the setup wizard and the settings
 * panel.
 *
 * Both screens ask for the same thing in the same order — mint a deep link,
 * open it, wait for the tap to come back through the webhook — and both used to
 * say it in their own words. One component instead, because the wording here is
 * the whole of what the user has to go on: the tap happens in another app, and
 * the only thing that tells this page it worked is asking the server again.
 *
 * **Why the asking is automatic.** Telegram delivers `/start <token>` to the
 * webhook, not to this tab; there is no push channel back to the browser, so a
 * page that never re-asks never notices. That used to be the user's job — "tap
 * Start, then check again" — and it is the wrong job to give them: they have
 * just switched apps, tapped a button that said it worked, and come back to a
 * screen still telling them to tap Start. A successful connection and a failed
 * one looked identical, and the only way to tell them apart was to press a link
 * whose purpose was not obvious.
 *
 * So while a connect attempt is live this polls, and the button stays only as a
 * fallback for the impatient. Three things bound the polling, because a loop
 * with no end is its own bug:
 *
 *   * **It stops when the chat connects.** The check that saw the chat id is
 *     the last one needed.
 *   * **It stops when the link expires.** The token is dead after ten minutes,
 *     so asking about it can only ever return the same answer — and the page
 *     says so, and offers a fresh link, rather than spinning forever.
 *   * **It pauses while the tab is hidden**, which is exactly where this page
 *     sits for most of the wait. Browsers throttle background timers anyway, so
 *     the poll that matters is the one fired the instant the user comes back —
 *     which is what makes the connection look instantaneous on a phone, where
 *     returning from Telegram is the whole of the interaction.
 */

/** How often the page asks, while it is asking at all. */
export const TELEGRAM_POLL_MS = 2_000;

/**
 * How long to watch when the server did not say.
 *
 * Matches the token's own lifetime (`LINK_TOKEN_TTL_MS`), which cannot be
 * imported here — it lives beside `node:crypto` in server-only code. The server
 * sends the real expiry with every link, so this is the floor, not the rule.
 */
export const TELEGRAM_WATCH_FALLBACK_MS = 10 * 60_000;

/** What the server hands back when a link is minted. */
type LinkResponse = { url: string; expiresAt?: string };

/**
 * When to stop watching a freshly minted link.
 *
 * The server's expiry is authoritative when it is usable, but it is measured on
 * the server's clock and read on the browser's. An expiry already in the past
 * says more about a skewed browser than about the token, and honouring it would
 * end the wait before it began — so an unusable answer falls back to the
 * lifetime the copy promises.
 */
export function watchDeadline(expiresAt: string | undefined, nowMs: number): number {
  const parsed = expiresAt === undefined ? NaN : Date.parse(expiresAt);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return nowMs + TELEGRAM_WATCH_FALLBACK_MS;
  return parsed;
}

type WatchStatus = 'idle' | 'waiting' | 'expired';

export function TelegramConnect({
  chatId,
  check,
  onError,
  onDisconnect,
}: {
  /** The connected chat, or '' when there is none. */
  chatId: string;
  /** Ask the server again whether the tap has landed. */
  check: () => Promise<void>;
  /** Where to put a failure — each screen has its own banner. */
  onError: (message: string) => void;
  /** Given only where giving the chat up is offered. */
  onDisconnect?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<WatchStatus>('idle');
  const [deadline, setDeadline] = useState(0);
  const connected = chatId !== '';

  // Both callers rebuild `check` on every render. Holding it in a ref keeps the
  // effect below from tearing its interval down and starting a new one each
  // time — which, on a page that re-renders faster than the interval, would
  // mean it never fires at all.
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  });

  // A connected chat is the answer this was waiting for, so it ends the watch
  // by itself rather than through an effect that writes state back — the flag
  // is derived, and there is no render in which both are true.
  const watching = status === 'waiting' && !connected;

  useEffect(() => {
    if (!watching) return;

    let stopped = false;
    const ask = async (): Promise<void> => {
      if (stopped) return;
      if (Date.now() >= deadline) {
        setStatus('expired');
        return;
      }
      if (document.hidden) return;
      try {
        await checkRef.current();
      } catch {
        // A check that could not reach the server says nothing about whether
        // the tap landed, and this is a wait, not a request the user made —
        // surfacing it would put an alarming banner under a page that is about
        // to succeed on its next try. Keep waiting; the expiry ends it.
      }
    };

    const timer = setInterval(() => void ask(), TELEGRAM_POLL_MS);
    // Coming back to the tab is the strongest signal there is that the tap just
    // happened, so it gets a check of its own rather than up to two seconds of
    // a screen that still says "waiting".
    const onReturn = (): void => {
      if (!document.hidden) void ask();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [watching, deadline]);

  const connect = useCallback(async (): Promise<void> => {
    try {
      const { url, expiresAt } = await api<LinkResponse>('/api/telegram/link', { method: 'POST' });
      // A new tab, not a redirect: losing this page on the way to Telegram
      // would mean coming back to one that has to be found again.
      window.open(url, '_blank', 'noopener,noreferrer');
      setDeadline(watchDeadline(expiresAt, Date.now()));
      setStatus('waiting');
    } catch (err) {
      onError((err as Error).message);
    }
  }, [onError]);

  if (connected) {
    return (
      <p className="hint" id="tg-connected" role="status">
        Connected to Telegram chat {chatId}.
        {onDisconnect && (
          <>
            {' '}
            <button
              id="tg-disconnect"
              className="link"
              onClick={() => {
                setStatus('idle');
                void onDisconnect().catch((err: Error) => onError(err.message));
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </p>
    );
  }

  return (
    <>
      <button
        id="tg-connect"
        className="btn-secondary"
        onClick={() => {
          void connect();
        }}
      >
        {status === 'expired' ? 'Get a new Telegram link' : 'Connect Telegram'}
      </button>
      {/* Mounted whether or not it has anything to say, so that a screen reader
          announces the change rather than the arrival of a new element. */}
      <p
        id="tg-status"
        role="status"
        aria-live="polite"
        className={status === 'idle' ? 'sr-only' : 'hint mt-xs'}
      >
        {status === 'waiting' && (
          <>
            <span className="spinner" aria-hidden="true" /> Waiting for you to tap{' '}
            <strong>Start</strong> in Telegram. This page picks it up on its own — no need to
            refresh.{' '}
            <button
              id="tg-check"
              className="link"
              onClick={() => {
                // Pressed rather than polled, so a failure here is an answer
                // the user is owed.
                void checkRef.current().catch((err: Error) => onError(err.message));
              }}
            >
              Check now
            </button>
          </>
        )}
        {status === 'expired' && (
          <>
            That link expired before anyone tapped <strong>Start</strong>, so it no longer works.
            Get a new one and try again.
          </>
        )}
      </p>
    </>
  );
}
