'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { readInstallPopupDismissed, storeInstallPopupDismissed } from '@/lib/pwa';
import { InstallOffer, useInstallability } from './InstallCard';

/** Subscribe to the dismissal flag changing — written only by "Don't show
 * again", via the synthetic `storage` event `storeInstallPopupDismissed`
 * dispatches alongside the real write. */
function subscribeToDismissed(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

/**
 * Whether "Don't show again" has ever been clicked on this device.
 *
 * The server snapshot says "dismissed" rather than guessing "not dismissed":
 * a popup that flashes open for someone who told it to stop is a worse bug
 * than one that takes an extra render to appear for someone who never has.
 */
function useInstallPopupDismissed(): boolean {
  return useSyncExternalStore(
    subscribeToDismissed,
    () => readInstallPopupDismissed(window.localStorage),
    () => true,
  );
}

/**
 * The popup that announces the install offer, rather than waiting for someone
 * to find it in Settings.
 *
 * `InstallCard` and `InstallButton` are both correct and both easy to miss —
 * a card at the bottom of Settings and an icon next to the menu button are
 * exactly the kind of thing a first-time visitor never notices. This modal is
 * what actually gets in front of them: it opens on its own, offers the same
 * one-tap install or the same manual steps as everything else here (only its
 * *form* ever differs, in `lib/pwa.ts`), and only "Don't show again" is
 * allowed to make it stop — "Not now" and installing (or reading the steps
 * and moving on) both leave it free to come back next visit, because someone
 * who has not yet installed is still exactly who this is for.
 *
 * Session-only state (`open`) tracks "Not now" for the current mount; the
 * localStorage flag is the only thing that persists, and only ever gets
 * written by "Don't show again".
 */
export function InstallPopup() {
  const state = useInstallability();
  const installable = state !== '' && state !== 'installed';
  const dismissedForever = useInstallPopupDismissed();

  // "Not now" — closes this mount without writing anything down, so the next
  // page load (the next visit) starts from a clean slate and offers again.
  const [closedThisVisit, setClosedThisVisit] = useState(false);

  const open = installable && !dismissedForever && !closedThisVisit;

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setClosedThisVisit(true);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* A tap outside the dialog is the same as "Not now": it comes back
          next visit, it just is not the answer being given right now. */}
      <div className="signout-confirm-backdrop" onClick={() => setClosedThisVisit(true)} />
      <div
        id="install-prompt-dialog"
        className="signout-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-prompt-title"
      >
        <h2 className="card-title" id="install-prompt-title">
          Install Elixia Booker
        </h2>
        <p className="hint">
          Add it to your home screen — it opens like an app, full screen, one tap away.
        </p>

        <InstallOffer state={state} />

        <div className="cluster mt-m">
          <button
            type="button"
            id="install-prompt-not-now-btn"
            className="btn-secondary btn-grow"
            onClick={() => setClosedThisVisit(true)}
          >
            Not now
          </button>
          <button
            type="button"
            id="install-prompt-never-btn"
            className="btn-quiet"
            onClick={() => storeInstallPopupDismissed()}
          >
            Don’t show again
          </button>
        </div>
      </div>
    </>
  );
}
