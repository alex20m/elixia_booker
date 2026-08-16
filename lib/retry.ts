/**
 * Bounded, polite retry.
 *
 * Two rules this must never break:
 *   1. The loop is bounded by a total wall-clock budget, not a retry count. A
 *      count-based cap silently becomes unbounded when each attempt is slow.
 *   2. Permanent outcomes stop the loop immediately. Retrying a full class or
 *      an expired session cannot succeed, and doing it anyway is the hammering
 *      this project exists to avoid.
 *
 * Backoff is exponential with jitter. The jitter is not decoration: a bot that
 * retries on an exact schedule after a shared T-0 is trivially identifiable,
 * and it also means every retry lands at the moment everyone else's does.
 */

import { isRetryable, type AttemptOutcome } from './types';

export interface RetryOptions {
  /** Total wall-clock budget across all attempts, in ms. */
  budgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests. Must return [0, 1). */
  random?: () => number;
  onAttempt?: (attempt: number, outcome: AttemptOutcome) => void;
  onWait?: (attempt: number, delayMs: number) => void;
  /**
   * Abort an in-flight attempt once the budget is spent. Defaults to real
   * timers; injectable so tests can drive it deterministically.
   *
   * Without this the budget bounds only when an attempt *starts*: a request
   * that hangs would run arbitrarily far past the deadline, which is exactly
   * what "capped at ~30s total" is supposed to rule out.
   */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export interface RetryResult {
  outcome: AttemptOutcome;
  attempts: number;
  /** True when the budget ran out before a final outcome was reached. */
  exhausted: boolean;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delay before attempt N (1-based), with full jitter.
 *
 * A server-supplied Retry-After always wins — ignoring it is what gets a client
 * blocked — but it is still clamped to maxDelayMs so a hostile or mistaken
 * header cannot park the Worker past its budget.
 */
export function backoffDelayMs(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, options.maxDelayMs);
  }
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  // Full jitter: uniform in [capped/2, capped]. Keeps a floor so retries do not
  // collapse into a burst, while still spreading them out.
  return Math.round(capped / 2 + random() * (capped / 2));
}

function retryAfterOf(outcome: AttemptOutcome): number | undefined {
  return 'retryAfterMs' in outcome ? outcome.retryAfterMs : undefined;
}

/**
 * Run one attempt, aborting it if the deadline passes mid-flight.
 *
 * The signal is passed through so the caller can cancel the underlying fetch
 * rather than merely abandoning it — an abandoned request still occupies a
 * connection and still arrives at Elixia, which is the opposite of polite.
 */
async function runBounded(
  attempt: (signal: AbortSignal) => Promise<AttemptOutcome>,
  remainingMs: number,
  setTimer: (fn: () => void, ms: number) => () => void,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let cancelTimer: (() => void) | undefined;

  const timeout = new Promise<AttemptOutcome>((resolve) => {
    cancelTimer = setTimer(() => {
      controller.abort();
      resolve({
        kind: 'error',
        detail: `attempt aborted: exceeded the remaining ${remainingMs}ms budget`,
      });
    }, remainingMs);
  });

  try {
    return await Promise.race([attempt(controller.signal), timeout]);
  } finally {
    cancelTimer?.();
  }
}

/**
 * Run `attempt` until it returns a final outcome or the budget is spent.
 *
 * The budget bounds three things, and all three matter:
 *   - no attempt *starts* after the deadline;
 *   - no wait *finishes* after it;
 *   - no attempt *runs past* it — it gets aborted.
 */
export async function retryWithBackoff(
  attempt: (signal: AbortSignal) => Promise<AttemptOutcome>,
  options: RetryOptions,
): Promise<RetryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? defaultTimer;

  const deadline = now() + options.budgetMs;
  let attempts = 0;
  let last: AttemptOutcome = { kind: 'error', detail: 'no attempt was made' };

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { outcome: last, attempts, exhausted: true };
    }

    attempts += 1;
    last = await runBounded(attempt, remaining, setTimer);
    options.onAttempt?.(attempts, last);

    if (!isRetryable(last)) {
      return { outcome: last, attempts, exhausted: false };
    }

    const delay = backoffDelayMs(attempts, options, retryAfterOf(last), random);
    if (now() + delay >= deadline) {
      return { outcome: last, attempts, exhausted: true };
    }

    options.onWait?.(attempts, delay);
    await sleep(delay);
  }
}
