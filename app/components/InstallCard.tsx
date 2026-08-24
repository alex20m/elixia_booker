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
 * string is the same value in a shape that can be compared. `''` is the one
 * the server sees, and means "not knowable here yet".
 */
export type Installability = '' | 'installed' | 'ready' | `manual:${Platform}`;

function readInstallability(): Installability {
  const state = installState({
    standalone: isStandalone(),
    promptAvailable: parkedInstallPrompt() !== null,
    platform: currentPlatform(),
  });
  return state.kind === 'manual' ? `manual:${state.platform}` : state.kind;
}

/**
 * The live installability, shared by the card, the header button and the last
 * page of the setup wizard.
 *
 * The empty snapshot is what the server sees: none of this is knowable
 * without a browser, and guessing would flash the wrong control at half of
 * visitors.
 */
export function useInstallability(): Installability {
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

/**
 * The offer itself — a one-tap button, or the steps to do it by hand.
 *
 * Split out from the card so the setup wizard can put the same offer on its
 * own last page without nesting a card inside a card. The state is passed in
 * rather than read here, so a caller that has already branched on it (the
 * wizard drops its install page entirely when there is nothing to offer)
 * cannot end up disagreeing with what this renders.
 */
export function InstallOffer({ state }: { state: Installability }) {
  if (state === '' || state === 'installed') return null;

  if (state === 'ready') {
    return (
      <button id="install-btn" type="button" onClick={() => void replayInstallPrompt()}>
        <InstallIcon />
        Install app
      </button>
    );
  }

  const { title, steps } = manualInstall(state.slice('manual:'.length) as Platform);

  return (
    <>
      <h3 className="card-title">{title}</h3>
      <ol className="install-steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </>
  );
}

export function InstallCard() {
  const state = useInstallability();

  if (state === '' || state === 'installed') return null;

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

      <InstallOffer state={state} />
    </section>
  );
}

/**
 * The compact header version, next to Sign out — hidden once the app is
 * already running installed, same as the card.
 *
 * There is no room in the bar to print the manual steps, so a browser with no
 * install API just hands off to wherever `onManual` points — the Settings
 * tab, where the full `InstallCard` prints them.
 */
export function InstallButton({ onManual }: { onManual: () => void }) {
  const state = useInstallability();

  if (state === '' || state === 'installed') return null;

  const ready = state === 'ready';

  return (
    <button
      id="install-header-btn"
      type="button"
      className="btn-icon"
      aria-label={ready ? 'Install app' : 'How to install the app'}
      onClick={() => (ready ? void replayInstallPrompt() : onManual())}
    >
      <InstallIcon />
    </button>
  );
}
