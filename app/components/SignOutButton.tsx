'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth/client';
import { ActionButton } from './ActionButton';

/**
 * Signing out, behind a confirmation.
 *
 * A press opens a dialog rather than signing out on the spot — the control
 * used to fire the request straight from the click, which is exactly what a
 * miss-tap next to something else on the page turns into an unwanted
 * sign-out. It is its own dialog rather than the nav menu's — that one turns
 * into a dropdown pinned to the bar past a width, which only works for a
 * control that opens from inside the bar. This one opens from wherever its
 * caller puts it, so it stays a centred, dimmed modal at every width.
 *
 * Its own component because it appears in more than one place, and because a
 * press that looks ignored is the press people repeat — here that means two
 * sign-out requests and, on a slow connection, someone tapping a button that
 * has already worked.
 */
export function SignOutButton({
  id,
  className,
  icon,
}: {
  id?: string;
  className?: string;
  /** For the menu, where every row is an icon and a label. */
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Tracked here rather than read off ActionButton's own pending state, which
  // it does not expose: this is what keeps Cancel, Escape and the backdrop
  // from abandoning a request that is already on the wire. A "cancel" that
  // let the request finish anyway would still sign the visitor out.
  const [signingOut, setSigningOut] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  // Focus goes back to the button that opened the dialog, not to the top of
  // the document — a keyboard visitor who opens and cancels this should end
  // up exactly where they started. A no-op while the request is in flight:
  // see the note on `signingOut` above.
  const close = useCallback(() => {
    if (signingOut) return;
    setOpen(false);
    trigger.current?.focus();
  }, [signingOut]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {icon}
        <span>Sign out</span>
      </button>

      {open && (
        <>
          {/* A tap outside the dialog is the same as Cancel. */}
          <div className="signout-confirm-backdrop" onClick={close} />
          <div
            id="signout-confirm-dialog"
            className="signout-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signout-confirm-title"
          >
            <h2 className="card-title" id="signout-confirm-title">
              Sign out?
            </h2>
            <p className="hint">You’ll need to sign in again to get back to your classes.</p>
            <div className="cluster mt-s">
              <button
                type="button"
                id="signout-confirm-cancel-btn"
                className="btn-secondary btn-grow"
                disabled={signingOut}
                onClick={close}
              >
                Cancel
              </button>
              {/* The guarded press, so a slow connection can't turn a second
                  tap into a second sign-out request. The dialog stays open
                  while it works, and Cancel/Escape/the backdrop stop doing
                  anything for as long as `signingOut` is true — closing it
                  early would leave the request in flight with nothing on
                  screen still tracking it, and still sign the visitor out a
                  moment after they thought they had backed out. */}
              <ActionButton
                id="signout-confirm-btn"
                className="btn-danger btn-grow"
                pendingLabel="Signing out…"
                onClick={async () => {
                  setSigningOut(true);
                  try {
                    await authClient.signOut();
                  } finally {
                    setSigningOut(false);
                  }
                }}
              >
                Sign out
              </ActionButton>
            </div>
          </div>
        </>
      )}
    </>
  );
}
