'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  INSTALL_PROMPT_EVENT,
  currentPlatform,
  installState,
  isStandalone,
  manualInstall,
  parkedInstallPrompt,
  type Platform,
} from '@/lib/pwa';
import { InstallIcon } from './icons';

/**
 * The offer to install the app to a home screen.
 *
 * Rendered as a card rather than a line in a menu because an install nobody
 * notices is an install nobody performs, and this app is far better as an icon
 * on a phone than as a tab someone has to remember to open.
 *
 * Everything about *what* to show lives in lib/pwa.ts, where it can be tested
 * against every platform without a browser. This component only reads the live
 * environment and calls the prompt.
 */
/**
 * Subscribe to the one thing that changes here: the prompt arriving, or the app
 * being installed. Both are announced on the same event by the script in <head>.
 */
function subscribeToInstallability(onChange: () => void): () => void {
  window.addEventListener(INSTALL_PROMPT_EVENT, onChange);
  return () => window.removeEventListener(INSTALL_PROMPT_EVENT, onChange);
}

/**
 * The install state, flattened to a string.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning the state
 * object itself — freshly built on every read — would re-render forever. The
 * string is the same value in a shape that can be compared.
 */
function readInstallability(): string {
  const state = installState({
    standalone: isStandalone(),
    promptAvailable: parkedInstallPrompt() !== null,
    platform: currentPlatform(),
  });
  return state.kind === 'manual' ? `manual:${state.platform}` : state.kind;
}

/**
 * The live installability, shared by the card and the header button.
 *
 * The empty snapshot is what the server sees: none of this is knowable
 * without a browser, and guessing would flash the wrong control at half of
 * visitors.
 */
function useInstallability(): string {
  return useSyncExternalStore(subscribeToInstallability, readInstallability, () => '');
}

/** Replay the parked Chromium prompt, then re-read: accepting it makes the
 * app standalone, and dismissing it spends the event Chromium gave us. */
async function replayInstallPrompt(): Promise<void> {
  const event = parkedInstallPrompt();
  if (event) {
    await event.prompt();
    await event.userChoice;
  }
  window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
}

export function InstallCard() {
  const state = useInstallability();

  if (state === '' || state === 'installed') return null;

  const ready = state === 'ready';
  const platform = state.slice('manual:'.length) as Platform;

  return (
    <section className="card install">
      <div className="card-head">
        <div>
          <h2 className="card-title">Install Elixia Booker</h2>
          <p className="card-sub">
            Add it to your home screen — it opens like an app, full screen, one tap away.
          </p>
        </div>
      </div>

      {ready ? (
        <button id="install-btn" type="button" onClick={() => void replayInstallPrompt()}>
          <InstallIcon />
          Install app
        </button>
      ) : (
        <>
          <h3 className="card-title">{manualInstall(platform).title}</h3>
          <ol className="install-steps">
            {manualInstall(platform).steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * The compact header version, next to Sign out — hidden once the app is
 * already running installed, same as the card.
 *
 * Where the browser hands us a prompt, the tap installs and nothing else
 * happens. Where it does not, the steps come to the button as a small popup
 * hanging off the bar, rather than the button carrying the visitor off to
 * another screen: someone who taps install has said what they want, and
 * answering that with a navigation to Settings makes them find the offer a
 * second time — and lands them somewhere they did not ask to be.
 */
export function InstallButton() {
  const state = useInstallability();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const ready = state === 'ready';
  const showSteps = open && !ready;

  /**
   * The two ways out that a popup has to honour beyond its own controls:
   * Escape, and a click that lands anywhere else.
   *
   * The listeners sit on `document` so they see clicks the popup never
   * receives, and the containment check is what keeps the very click that
   * opened the popup — still on its way up to `document` — from closing it
   * again on arrival.
   */
  useEffect(() => {
    if (!showSteps) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick);
    };
  }, [showSteps]);

  if (state === '' || state === 'installed') return null;

  const platform = state.slice('manual:'.length) as Platform;
  const guide = manualInstall(platform);

  return (
    <div className="install-anchor" ref={wrapper}>
      <button
        id="install-header-btn"
        type="button"
        className="btn-icon"
        aria-label={ready ? 'Install app' : 'How to install the app'}
        aria-haspopup={ready ? undefined : 'dialog'}
        aria-expanded={ready ? undefined : showSteps}
        onClick={() => (ready ? void replayInstallPrompt() : setOpen((was) => !was))}
      >
        <InstallIcon />
      </button>

      {showSteps && (
        <div id="install-popup" className="install-popup" role="dialog" aria-label={guide.title}>
          <h2 className="card-title">{guide.title}</h2>
          <ol className="install-steps">
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <button
            id="install-popup-close"
            type="button"
            className="btn btn-secondary btn-sm btn-block mt-s"
            onClick={() => setOpen(false)}
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
