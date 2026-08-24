'use client';

import { useEffect, useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import { MEMBERSHIP_OPTIONS } from '@/lib/membership';
import { TIME_ZONE_GROUPS } from '@/lib/timezones';
import type { SetupState } from '@/lib/service';
import type { NotifyChannel } from '@/lib/types';
import { ActionButton } from './components/ActionButton';
import { LoadingScreen, SkeletonCard } from './components/Loading';
import { Shell } from './components/Shell';
import { InstallOffer, useInstallability } from './components/InstallCard';
import { TelegramConnect } from './components/TelegramConnect';

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
 *   * **Gym account.** Without Elixia credentials there is nothing to book
 *     with — the rest of the wizard would finish an account that can only
 *     ever show a dashboard, never book a class.
 *
 * Every failure there is silent. The app keeps running, the dashboard looks
 * healthy, and the classes quietly do not get booked. So the answers are asked
 * for once, up front, and the pages hold two rules that make asking worth
 * anything: **nothing is preselected**, and **nothing is typed that could be
 * picked**. A wizard that opens with 7 days and Europe/Helsinki already filled
 * in is a default in a form's clothing — most people would click past it and
 * never know they had been asked.
 *
 * Four pages rather than one long form, so each decision is read rather than
 * skimmed, and each page's Next is the thing that will not move until it has an
 * answer.
 *
 * The gym account page is last of the four and submits separately from the
 * other three: `/api/elixia` only accepts a request once the account is already
 * configured (see lib/service.ts's note on why linking stays its own
 * operation), so saving this wizard calls `/api/setup` first and `/api/elixia`
 * second. If Elixia rejects the credentials, the first call has already gone
 * through — which is fine, because an account that is configured but not yet
 * linked is exactly what the dashboard's own "Link your Elixia account" card is
 * for.
 *
 * After those four comes a fifth page that asks for nothing: the offer to
 * install the app to a home screen. It is deliberately the only page that can
 * be walked past, and deliberately placed *after* the save rather than before
 * it — a page that can be skipped must not be able to take four pages of
 * answers with it. Setup is the one moment the offer is certain to be seen, and
 * an app opened from a home screen is the difference between a booker someone
 * remembers to check and a tab they lose. Someone already running the installed
 * app never sees the page at all.
 */

/** The pages that have to be answered. */
const CONFIG_STEPS = ['Membership', 'Timezone', 'Notifications', 'Gym account'] as const;

/** And the one that does not. */
const INSTALL_STEP = 'Install app';

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
  const [elixiaEmail, setElixiaEmail] = useState('');
  const [elixiaPassword, setElixiaPassword] = useState('');
  const [error, setError] = useState('');

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

  const installability = useInstallability();
  const onInstallStep = step === CONFIG_STEPS.length;
  // Dropped for someone already running the installed app, where the offer
  // would be nonsense.
  const offersInstall = installability !== 'installed';
  // Kept in the page list once the wizard is standing on it, so a browser that
  // reports itself installed the moment the prompt is accepted cannot pull the
  // page out from under the visitor still reading it.
  const steps: readonly string[] =
    offersInstall || onInstallStep ? [...CONFIG_STEPS, INSTALL_STEP] : CONFIG_STEPS;
  const lastConfigStep = step === CONFIG_STEPS.length - 1;

  // What each page needs before it will let the visitor move on. The gym
  // account condition is the destination as well as the channel, because a
  // channel with nowhere to send is the failure that page exists to prevent —
  // the server refuses it too, and this is only the polite half. The install
  // page asks for nothing, so nothing is required of it.
  const answered =
    step === 0
      ? windowDays !== ''
      : step === 1
        ? timeZone !== ''
        : step === 2
          ? channel === 'none' ||
            (channel === 'email' && email.trim() !== '') ||
            (channel === 'telegram' && connected)
          : !lastConfigStep || (elixiaEmail.trim() !== '' && elixiaPassword !== '');

  const save = async (): Promise<void> => {
    setError('');
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
    // Separate from the call above: `/api/elixia` only accepts a request once
    // the account is configured, and a rejected login here must not undo the
    // setup answers that were just saved.
    await api('/api/elixia', {
      method: 'POST',
      body: JSON.stringify({ email: elixiaEmail.trim(), password: elixiaPassword }),
    });
    // Everything asked for is saved; the install page is all that is left, and
    // it is only shown where there is something to install.
    if (offersInstall) setStep(step + 1);
    else onDone();
  };

  // Drawn only once the server has answered. Two of these pages depend on what
  // it says — the email field is filled in from the account, and the Telegram
  // page differs depending on whether this deployment has a webhook — so
  // rendering first means rendering a form that visibly rewrites itself, and
  // briefly offering a Telegram page with nothing on it. An error is a decided
  // outcome rather than a wait, so it falls through and the banner explains it.
  if (!state && !error) {
    return (
      <LoadingScreen label="Loading your setup…" narrow>
        <SkeletonCard lines={3} />
      </LoadingScreen>
    );
  }

  return (
    <Shell>
      <main className="main main-narrow">
        <div className="hero">
          <h1>Set up your booker</h1>
          <p className="hero-sub">
            A few quick questions. Your answers decide when your classes get booked, and whether
            you hear about it.
          </p>
        </div>

        <section className="card">
          {/* A bar per page rather than "Step 2 of 3" alone: the count is still
              there for anyone who wants it, and the bars say how much is left
              without being read. */}
          <div className="steps" aria-hidden="true">
            {steps.map((name, index) => (
              <span key={name} className={index <= step ? 'step-dot is-done' : 'step-dot'} />
            ))}
          </div>

          <div className="card-head">
            <div>
              <h2 className="card-title">{steps[step]}</h2>
              <p className="card-sub" id="setup-progress">
                Step {step + 1} of {steps.length}
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
                  <TelegramConnect
                    chatId={state.telegramChatId || chatId}
                    check={load}
                    onError={setError}
                  />
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

          {step === 3 && (
            <div className="stack">
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="setup-elixia-email">Elixia email</label>
                  <input
                    id="setup-elixia-email"
                    type="email"
                    autoComplete="username"
                    value={elixiaEmail}
                    onChange={(e) => setElixiaEmail(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="setup-elixia-password">Elixia password</label>
                  <input
                    id="setup-elixia-password"
                    type="password"
                    autoComplete="current-password"
                    value={elixiaPassword}
                    onChange={(e) => setElixiaPassword(e.target.value)}
                  />
                </div>
              </div>
              <p className="hint">
                Booker needs these to reserve classes on your behalf. Your password is stored{' '}
                <strong>encrypted</strong>, because the bot has to re-authenticate on its own when a
                session expires — otherwise booking would stop silently until you noticed.
              </p>
            </div>
          )}

          {onInstallStep && (
            <div className="stack">
              <p className="card-sub">
                Add Elixia Booker to your home screen — it opens like an app, full screen, one tap
                away.
              </p>

              {installability === 'installed' ? (
                <p className="hint">Installed. Finish to open your dashboard.</p>
              ) : (
                <InstallOffer state={installability} />
              )}

              <p className="hint">
                Optional, and nothing is waiting on it — your setup is already saved, and booking
                runs whether or not the app is on your home screen. You can install it later from
                Settings.
              </p>
            </div>
          )}

          {error && (
            <div className="banner banner-err mt-m" id="setup-error">
              <span>{error}</span>
            </div>
          )}

          <div className="cluster mt-m">
            {/* No way back from the install page: what came before it has been
                submitted already, and stepping back into it would offer to
                submit it a second time. */}
            {step > 0 && !onInstallStep && (
              <button className="btn-quiet" id="setup-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {onInstallStep ? (
              // Outlined where there is a real install button above it to
              // press, so the page has one filled button rather than two
              // competing ones; filled where the offer is only instructions
              // and this is the only thing to press.
              <button
                id="setup-done"
                className={installability === 'ready' ? 'btn-secondary btn-grow' : 'btn-grow'}
                onClick={onDone}
              >
                Finish
              </button>
            ) : lastConfigStep ? (
              <ActionButton
                id="setup-finish"
                className="btn-grow"
                disabled={!answered}
                pendingLabel="Saving…"
                onError={(err) => setError(err.message)}
                onClick={save}
              >
                {offersInstall ? 'Save and continue' : 'Finish setup'}
              </ActionButton>
            ) : (
              <button
                id="setup-next"
                className="btn-grow"
                disabled={!answered}
                onClick={() => setStep(step + 1)}
              >
                Next
              </button>
            )}
          </div>
        </section>
      </main>
    </Shell>
  );
}
