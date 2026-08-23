'use client';

import { useSyncExternalStore } from 'react';
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

export function InstallCard() {
  // The empty snapshot is what the server sees: none of this is knowable
  // without a browser, and guessing would flash the wrong card at half of
  // visitors.
  const state = useSyncExternalStore(subscribeToInstallability, readInstallability, () => '');

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
        <button
          id="install-btn"
          type="button"
          onClick={async () => {
            const event = parkedInstallPrompt();
            if (event) {
              await event.prompt();
              await event.userChoice;
            }
            // Re-read: accepting the prompt makes the app standalone, and
            // dismissing it spends the event Chromium gave us.
            window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
          }}
        >
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
