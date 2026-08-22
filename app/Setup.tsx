'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import { MEMBERSHIP_OPTIONS } from '@/lib/membership';
import { TIME_ZONE_GROUPS } from '@/lib/timezones';
import type { SetupState } from '@/lib/service';
import type { NotifyChannel } from '@/lib/types';

/**
 * The configuration pages a new account goes through before it can use the app.
 *
 * This exists because the three things it asks for are the three this app
 * cannot guess, and gets no feedback about when it guesses wrong:
 *
 *   * **Membership.** 7 days or 14 is a property of the contract the user has
 *     with Elixia. Guess low and a Premium member books a week late, every
 *     week, for classes that filled while they waited.
 *   * **Timezone.** A release instant is a wall-clock time turned into an
 *     epoch millisecond. An hour out is a booking that fires an hour out.
 *   * **Notifications.** With no channel there is nowhere to send the one
 *     message that matters most — that booking has stopped.
 *
 * Every failure there is silent. The app keeps running, the dashboard looks
 * healthy, and the classes quietly do not get booked. So the answers are asked
 * for once, up front, and the pages hold two rules that make asking worth
 * anything: **nothing is preselected**, and **nothing is typed that could be
 * picked**. A wizard that opens with 7 days and Europe/Helsinki already filled
 * in is a default in a form's clothing — most people would click past it and
 * never know they had been asked.
 *
 * Three pages rather than one long form, so each decision is read rather than
 * skimmed, and each page's Next is the thing that will not move until it has an
 * answer.
 */

const STEPS = ['Membership', 'Timezone', 'Notifications'] as const;

export default function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<SetupState | null>(null);

  // Empty strings, not chosen values: `''` is what "no answer yet" looks like
  // in a `<select>`, and it is what keeps Next disabled.
  const [windowDays, setWindowDays] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [channel, setChannel] = useState<NotifyChannel | ''>('');
  const [email, setEmail] = useState('');
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [awaitingTap, setAwaitingTap] = useState(false);

  const apply = (loaded: SetupState): void => {
    setState(loaded);
    // Prefilled, never overwritten: an address the visitor has already edited
    // is their answer, and a "check again" on the Telegram page must not
    // quietly put the suggestion back.
    setEmail((current) => current || loaded.suggestedEmail);
  };

  /** Ask again — what the Telegram page's "check again" does. */
  const load = async (): Promise<void> => {
    try {
      apply(await api<SetupState>('/api/setup'));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    // The state update lives in the continuation rather than in the effect
    // body, which keeps this off React's cascading-render path — the same
    // shape the dashboard's own first load uses.
    let active = true;
    void api<SetupState>('/api/setup').then(
      (loaded) => {
        if (active) apply(loaded);
      },
      (err: Error) => {
        if (active) setError(err.message);
      },
    );

    return () => {
      active = false;
    };
  }, []);

  const connected = Boolean(state?.telegramChatId || chatId);

  // What each page needs before it will let the visitor move on. The finish
  // condition is the destination as well as the channel, because a channel
  // with nowhere to send is the failure this page exists to prevent — the
  // server refuses it too, and this is only the polite half.
  const answered =
    step === 0
      ? windowDays !== ''
      : step === 1
        ? timeZone !== ''
        : channel === 'none' ||
          (channel === 'email' && email.trim() !== '') ||
          (channel === 'telegram' && connected);

  const finish = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({
          bookingWindowDays: Number(windowDays),
          timeZone,
          notifyChannel: channel,
          ...(channel === 'email' ? { notifyEmail: email.trim() } : {}),
          // Only where this deployment has no webhook and the field is real.
          ...(channel === 'telegram' && !state?.telegramConnect ? { telegramChatId: chatId } : {}),
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    setError('');
    try {
      const { url } = await api<{ url: string }>('/api/telegram/link', { method: 'POST' });
      // A new tab, so the half-finished setup is still here to come back to.
      window.open(url, '_blank', 'noopener,noreferrer');
      setAwaitingTap(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Set up your booker</h1>
      <p className="sub">
        Three questions, once. Nothing here has a default — each answer changes
        when your classes get booked, or whether you hear about it.
      </p>

      <div className="card">
        <p className="sub" id="setup-progress" style={{ marginTop: 0 }}>
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>

        {step === 0 && (
          <div className="row">
            <div>
              <label htmlFor="setup-window">Your Elixia membership</label>
              <select
                id="setup-window"
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
              >
                <option value="">Choose your membership</option>
                {MEMBERSHIP_OPTIONS.map((option) => (
                  <option key={option.days} value={String(option.days)}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="hint">
                This is how far ahead Elixia lets you book. It is on your
                membership — pick the wrong one and every booking fires on the
                wrong day.
              </p>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="row">
            <div>
              <label htmlFor="setup-tz">The timezone your gym is in</label>
              <select id="setup-tz" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                <option value="">Choose your timezone</option>
                {TIME_ZONE_GROUPS.map((group) => (
                  <optgroup key={group.region} label={group.region}>
                    {group.zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="hint">
                Class times are read in this zone. Pick the city your classes
                are held in, not the one you happen to be in today.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <>
            <div className="row">
              <div>
                <label htmlFor="setup-channel">Where should booking alerts go?</label>
                <select
                  id="setup-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as NotifyChannel | '')}
                >
                  <option value="">Choose a channel</option>
                  <option value="email">Email</option>
                  <option value="telegram">Telegram</option>
                  <option value="none">Nothing — do not tell me</option>
                </select>
              </div>
            </div>

            {channel === 'email' && (
              <div className="row">
                <div>
                  <label htmlFor="setup-email">Email address</label>
                  <input
                    id="setup-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <p className="hint">
                    Filled in from the address you signed in with. Change it if
                    alerts should go somewhere else.
                  </p>
                </div>
              </div>
            )}

            {channel === 'telegram' && state?.telegramConnect && (
              <div className="row">
                <div>
                  {connected ? (
                    <p className="hint">
                      Connected to Telegram chat {state.telegramChatId || chatId}.
                    </p>
                  ) : (
                    <>
                      <button id="tg-connect" onClick={connect}>
                        Connect Telegram
                      </button>
                      {awaitingTap && (
                        <p className="hint">
                          Tap <strong>Start</strong> in Telegram, then{' '}
                          <button
                            id="tg-check"
                            className="link"
                            onClick={() => {
                              void load();
                            }}
                          >
                            check again
                          </button>
                          . The link is good for ten minutes.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {channel === 'telegram' && state && !state.telegramConnect && (
              <div className="row">
                <div>
                  <label htmlFor="setup-chat">Telegram chat ID</label>
                  <input
                    id="setup-chat"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    placeholder="e.g. 123456789"
                  />
                  <p className="hint">
                    This deployment has no Telegram webhook configured, so the
                    chat ID has to be entered by hand. See SETUP.md.
                  </p>
                </div>
              </div>
            )}

            {channel === 'none' && (
              <p className="hint">
                Bookings still run — you just will not be told about them,
                including when your Elixia session expires and booking stops.
              </p>
            )}
          </>
        )}

        {error && (
          <div className="banner banner-err" id="setup-error">
            {error}
          </div>
        )}

        {step > 0 && (
          <>
            <button className="ghost" id="setup-back" onClick={() => setStep(step - 1)}>
              Back
            </button>{' '}
          </>
        )}
        {step < STEPS.length - 1 ? (
          <button id="setup-next" disabled={!answered} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button id="setup-finish" disabled={!answered || busy} onClick={finish}>
            {busy ? 'Saving…' : 'Finish setup'}
          </button>
        )}
      </div>
    </>
  );
}
