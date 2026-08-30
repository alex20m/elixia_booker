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
 * none of `TelegramConnect`'s polling — the URL is either shown or it is not.
 *
 * Building the subscribe URL is deliberately the browser's job, not the
 * server's: the server never learns this deployment's own public origin
 * except through `APP_URL` (needed only for QStash), and the address someone
 * is looking at *right now* is always the one their calendar app needs to
 * reach, with no extra environment variable required to make that true.
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

  const turnOn = async (): Promise<void> => {
    const result = await api<{ enabled: boolean; token: string }>('/api/calendar', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    onChange(result);
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
        <p className="hint">
          Add your booked classes to a calendar app automatically — the same way booking through
          the SATS app does. A class appears once it is actually booked, not before.
        </p>
        <ActionButton
          id="calendar-enable"
          className="btn-secondary mt-s"
          pendingLabel="Turning on…"
          onError={(err) => onError(err.message)}
          onClick={turnOn}
        >
          Turn on calendar sync
        </ActionButton>
      </div>
    );
  }

  const url = feedUrl(token);

  return (
    <div>
      <p className="hint" id="calendar-status" role="status">
        Calendar sync is on. Add this address in your calendar app as a new subscribed calendar
        (in Google Calendar: Other calendars → From URL; in Apple Calendar: File → New Calendar
        Subscription).
      </p>
      <div className="field mt-s">
        <label htmlFor="calendar-url">Subscribe URL</label>
        <input id="calendar-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <div className="cluster mt-s">
        <button type="button" id="calendar-copy" className="btn-secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a id="calendar-webcal" className="btn btn-secondary" href={url.replace(/^https?:/, 'webcal:')}>
          Add to calendar app
        </a>
      </div>
      <div className="cluster mt-s">
        <ActionButton
          id="calendar-regenerate"
          className="link"
          pendingLabel="Getting a new link…"
          onError={(err) => onError(err.message)}
          onClick={regenerate}
        >
          Get a new link
        </ActionButton>
        <ActionButton
          id="calendar-disable"
          className="link"
          pendingLabel="Turning off…"
          onError={(err) => onError(err.message)}
          onClick={turnOff}
        >
          Turn off
        </ActionButton>
      </div>
    </div>
  );
}
