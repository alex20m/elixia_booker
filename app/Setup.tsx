'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import { MEMBERSHIP_OPTIONS } from '@/lib/membership';
import { TIME_ZONE_GROUPS } from '@/lib/timezones';
import type { SetupState } from '@/lib/service';
import type { NotifyChannel } from '@/lib/types';
import { Shell } from './components/Shell';

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
    <Shell>
      <main className="main main-narrow">
        <div className="hero">
          <h1>Set up your booker</h1>
          <p className="hero-sub">
            Three quick questions. Your answers decide when your classes get booked, and whether
            you hear about it.
          </p>
        </div>

        <section className="card">
          {/* A bar per page rather than "Step 2 of 3" alone: the count is still
              there for anyone who wants it, and the bars say how much is left
              without being read. */}
          <div className="steps" aria-hidden="true">
            {STEPS.map((name, index) => (
              <span key={name} className={index <= step ? 'step-dot is-done' : 'step-dot'} />
            ))}
          </div>

          <div className="card-head">
            <div>
              <h2 className="card-title">{STEPS[step]}</h2>
              <p className="card-sub" id="setup-progress">
                Step {step + 1} of {STEPS.length}
              </p>
            </div>
          </div>

          {step === 0 && (
            <div className="field">
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
                This is how far ahead Elixia lets you book. It is on your membership — pick the
                wrong one and every booking fires on the wrong day.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="field">
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
                Class times are read in this zone. Pick the city your classes are held in, not the
                one you happen to be in today.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <div className="field">
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

              {channel === 'email' && (
                <div className="field">
                  <label htmlFor="setup-email">Email address</label>
                  <input
                    id="setup-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <p className="hint">
                    Filled in from the address you signed in with. Change it if alerts should go
                    somewhere else.
                  </p>
                </div>
              )}

              {channel === 'telegram' && state?.telegramConnect && (
                <div>
                  {connected ? (
                    <p className="hint">
                      Connected to Telegram chat {state.telegramChatId || chatId}.
                    </p>
                  ) : (
                    <>
                      <button id="tg-connect" className="btn-secondary" onClick={connect}>
                        Connect Telegram
                      </button>
                      {awaitingTap && (
                        <p className="hint mt-xs">
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
              )}

              {channel === 'telegram' && state && !state.telegramConnect && (
                <div className="field">
                  <label htmlFor="setup-chat">Telegram chat ID</label>
                  <input
                    id="setup-chat"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    placeholder="e.g. 123456789"
                  />
                  <p className="hint">
                    This deployment has no Telegram webhook configured, so the chat ID has to be
                    entered by hand.
                  </p>
                </div>
              )}

              {channel === 'none' && (
                <p className="hint">
                  Bookings still run — you just will not be told about them, including when your
                  Elixia session expires and booking stops.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="banner banner-err mt-m" id="setup-error">
              <span>{error}</span>
            </div>
          )}

          <div className="cluster mt-m">
            {step > 0 && (
              <button className="btn-quiet" id="setup-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                id="setup-next"
                className="btn-grow"
                disabled={!answered}
                onClick={() => setStep(step + 1)}
              >
                Next
              </button>
            ) : (
              <button
                id="setup-finish"
                className="btn-grow"
                disabled={!answered || busy}
                onClick={finish}
              >
                {busy ? 'Saving…' : 'Finish setup'}
              </button>
            )}
          </div>
        </section>
      </main>
    </Shell>
  );
}
