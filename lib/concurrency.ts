/**
 * A gate that lets only so many async tasks run at once.
 *
 * The booking tick needs this for one reason, and it is worth stating plainly
 * because the obvious reading is backwards: this exists to keep work *off* the
 * critical path, not to throttle the path itself. Everything a booking needs
 * before the release instant — loading a profile, refreshing a gym session —
 * and everything it does afterwards — writing history, sending a notification
 * — is gated, so a hundred users releasing in the same minute cannot open a
 * hundred simultaneous database connections and slow each other down. The race
 * to T-0 itself is never gated: a queue there is exactly the head-of-line
 * blocking that makes one user's booking land 3ms after release and the next
 * user's ten seconds after it.
 *
 * Waiters are woken in the order they arrived, so a queued task cannot be
 * starved by later arrivals — under a burst, "everyone eventually" beats
 * "whoever is luckiest with the event loop".
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }

  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // The releasing task handed its slot straight over, so `active` already
    // counts this one. Incrementing here as well would double-book the slot.
  };

  const release = (): void => {
    const next = waiting.shift();
    // Transfer rather than decrement-then-reacquire: dropping to `active - 1`
    // and letting the waiter re-check would leave a window in which a brand
    // new caller sees a free slot and overtakes the queue.
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      // A thrown task still has to give its slot back, or the gate closes for
      // good after `limit` failures.
      release();
    }
  };
}
