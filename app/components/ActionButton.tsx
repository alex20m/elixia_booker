'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from './Loading';

/**
 * A button whose work takes a moment.
 *
 * Every control in this app that calls the server used to be a plain button
 * with an async onClick, and between the press and the response it looked
 * exactly like a button that had not been pressed. That is two bugs wearing one
 * coat:
 *
 *   * **Nothing says it is working.** On a phone on gym wifi, "Remove" takes
 *     long enough to read as broken.
 *   * **Nothing stops a second press.** Which is the real damage: a second
 *     DELETE, a second subscription, a second link attempt against Elixia's own
 *     rate limiter. A few of these buttons had a `busy` flag and most did not,
 *     and there was no way to tell from a call site which kind it was.
 *
 * So the wait is the button's own business rather than each caller's. Pressing
 * it disables it, puts a spinner where its icon was, and says what is
 * happening; pressing it again while it works does nothing at all.
 *
 * The guard is a ref rather than the rendered `disabled`, because `disabled`
 * only lands after a render — two clicks dispatched in the same tick both find
 * a button that is still enabled, which is exactly what a double-tap is.
 */
export function ActionButton({
  onClick,
  pendingLabel,
  onError,
  children,
  className,
  id,
  disabled,
  'aria-label': ariaLabel,
}: {
  /** The work. Rejections go to `onError`, or to the caller's own handler. */
  onClick: () => Promise<unknown>;
  /** What the button says while it works. Its normal label when omitted. */
  pendingLabel?: string;
  /**
   * Where a failure goes. Without one a rejection is re-thrown out of band —
   * the same unhandled rejection a bare `onClick={async () => …}` would
   * produce, rather than a failure this component quietly swallows.
   */
  onError?: (error: Error) => void;
  children: React.ReactNode;
  className?: string;
  id?: string;
  /** Reasons of the caller's own, on top of "it is already running". */
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [pending, setPending] = useState(false);
  // Two refs, doing different jobs: one refuses re-entry within a tick, the
  // other keeps a finished request from setting state on a button that has
  // since been unmounted — which is what a Remove button does to itself.
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const press = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setPending(true);

    void (async () => {
      try {
        await onClick();
      } catch (err) {
        if (onError) onError(err as Error);
        else
          queueMicrotask(() => {
            throw err;
          });
      } finally {
        running.current = false;
        if (mounted.current) setPending(false);
      }
    })();
  }, [onClick, onError]);

  return (
    <button
      type="button"
      id={id}
      className={className}
      aria-label={ariaLabel}
      aria-busy={pending || undefined}
      disabled={pending || disabled}
      onClick={press}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
