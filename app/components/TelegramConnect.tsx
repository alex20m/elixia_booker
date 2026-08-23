'use client';

import { useState } from 'react';
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
 */

/** What the server hands back when a link is minted. */
type LinkResponse = { url: string; expiresAt?: string };

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
  const [awaitingTap, setAwaitingTap] = useState(false);
  const connected = chatId !== '';

  const connect = async (): Promise<void> => {
    try {
      const { url } = await api<LinkResponse>('/api/telegram/link', { method: 'POST' });
      // A new tab, not a redirect: losing this page on the way to Telegram
      // would mean coming back to one that has to be found again.
      window.open(url, '_blank', 'noopener,noreferrer');
      setAwaitingTap(true);
    } catch (err) {
      onError((err as Error).message);
    }
  };

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
                setAwaitingTap(false);
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
        Connect Telegram
      </button>
      {awaitingTap && (
        <p className="hint mt-xs" id="tg-status">
          Tap <strong>Start</strong> in Telegram, then{' '}
          <button
            id="tg-check"
            className="link"
            onClick={() => {
              void check();
            }}
          >
            check again
          </button>
          . The link is good for ten minutes.
        </p>
      )}
    </>
  );
}
