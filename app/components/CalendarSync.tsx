'use client';

import { useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import { ActionButton } from './ActionButton';

/**
 * The calendar-sync control, shared by the setup wizard and the settings
 * panel — the same pairing `TelegramConnect` uses, and for the same reason:
 * both screens turn the same thing on in the same words.
 *
 * Unlike Telegram, there is nothing to wait for here. Turning sync on is a
 * single request that comes back with the token straight away, so this has
 * none of `TelegramConnect`'s polling — the URL is either ready or it is not.
 *
 * Building the subscribe URL is deliberately the browser's job, not the
 * server's: the server never learns this deployment's own public origin
 * except through `APP_URL` (needed only for QStash), and the address someone
 * is looking at *right now* is always the one their calendar app needs to
 * reach, with no extra environment variable required to make that true.
 *
 * The off-state button does two things in one tap — turns sync on *and*
 * hands off to whatever the device registers for `webcal:` — because asking
 * for two taps ("turn on", then "add to calendar") to get one outcome is the
 * kind of friction someone abandons a skippable step over. Everything past
 * that first tap (copying the link by hand, rotating it) is real fallback,
 * not the common path someone who has never heard of a calendar feed URL
 * needs to see, so it sits behind a "More options" disclosure rather than
 * out in the open next to "Open in calendar app" and "Turn off" — the two
 * things everyone actually wants from this control.
 */
export function CalendarSync({
  enabled,
  token,
  onChange,
  onError,
}: {
  enabled: boolean;
  /** The feed token, or '' if sync has never been turned on. */
  token: string;
  /** Called after any change here, with the state to remember. */
  onChange: (next: { enabled: boolean; token: string }) => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const feedUrl = (t: string): string =>
    typeof window === 'undefined' ? '' : `${window.location.origin}/api/calendar/${t}.ics`;
  const webcalUrl = (t: string): string => feedUrl(t).replace(/^https?:/, 'webcal:');

  /** One tap: turn sync on, then hand straight off to the calendar app. */
  const enableAndOpen = async (): Promise<void> => {
    const result = await api<{ enabled: boolean; token: string }>('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    onChange(result);
    // A plain navigation, not a popup: unlike `window.open`, this is allowed
    // to run after the `await` above, so the OS still treats it as the tap
    // that opened the calendar app rather than silently blocking it.
    window.location.href = webcalUrl(result.token);
  };

  const regenerate = async (): Promise<void> => {
    const result = await api<{ enabled: boolean; token: string }>('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({ regenerate: true }),
    });
    setCopied(false);
    onChange(result);
  };

  const turnOff = async (): Promise<void> => {
    await api('/api/calendar', { method: 'DELETE' });
    onChange({ enabled: false, token });
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(feedUrl(token));
      setCopied(true);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  if (!enabled) {
    return (
      <div>
        <p className="hint">Classes you book will show up on your calendar automatically.</p>
        <ActionButton
          id="calendar-enable"
          className="btn-secondary mt-s"
          pendingLabel="Turning on…"
          onError={(err) => onError(err.message)}
          onClick={enableAndOpen}
        >
          Turn on calendar sync
        </ActionButton>
      </div>
    );
  }

  return (
    <div>
      <p className="hint" id="calendar-status" role="status">
        Calendar sync is on — booked classes show up on your calendar automatically.
      </p>
      <div className="cluster mt-s">
        <a id="calendar-webcal" className="btn btn-secondary" href={webcalUrl(token)}>
          Open in calendar app
        </a>
        <ActionButton
          id="calendar-disable"
          className="btn-secondary"
          pendingLabel="Turning off…"
          onError={(err) => onError(err.message)}
          onClick={turnOff}
        >
          Turn off
        </ActionButton>
      </div>
      <details className="mt-xs">
        <summary className="hint">Not seeing it in your calendar app? More options</summary>
        <p className="hint mt-xs">
          <button type="button" id="calendar-copy" className="link" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy calendar address'}
          </button>{' '}
          ·{' '}
          <ActionButton
            id="calendar-regenerate"
            className="link"
            pendingLabel="Resetting…"
            onError={(err) => onError(err.message)}
            onClick={regenerate}
          >
            Reset calendar address
          </ActionButton>
        </p>
      </details>
    </div>
  );
}
