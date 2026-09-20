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
 *
 * There are two bands, not one, because "wait" answers two different
 * questions. A rate limit or a transport error is the other side asking for
 * room, and the right response is to ask progressively less often. A
 * `too-early` is the thing simply not existing yet, and there the only thing
 * that matters is noticing promptly when it does — so that band is capped
 * tight by `pollMaxDelayMs`. See its doc comment for why conflating the two
 * costs a shared deadline seconds.
 */

import { isRetryable, type AttemptOutcome } from './types';

export interface RetryOptions {
  /** Total wall-clock budget across all attempts, in ms. */
  budgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Cap on the wait after a `too-early` outcome, when it should be tighter
   * than `maxDelayMs`.
   *
   * `too-early` is not the server pushing back — it is the resource not
   * existing yet (for this app, a class Elixia has not published). Backing
   * off exponentially from it is answering the wrong question: the longer the
   * thing takes to appear, the *less* often we look for it, so the lateness
   * when it finally appears grows without bound up to `maxDelayMs`. Worse for
   * a shared deadline, the growth is multiplicative and independently
   * jittered, so two clients waiting on the same instant drift onto different
   * probe schedules and reach it seconds apart.
   *
   * Left undefined, `maxDelayMs` applies to every retryable outcome as before.
   */
  pollMaxDelayMs?: number;
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
 * Whether this failure means "the thing is not there yet" rather than "the
 * other side wants to be left alone".
 *
 * `too-early` is the obvious case. The subtle one is a 4xx from the booking
 * call itself: once the class can be resolved before the release instant, the
 * POST is the *first* thing that happens at T-0, so a window that has not
 * quite opened is rejected as a booking failure rather than showing up as a
 * lookup that found nothing. Elixia publishes no "too early" code at all
 * (docs/api.md §5), so that rejection lands in the generic 4xx bucket, and
 * left on the exponential band the wait for a window about to open grows to
 * `maxDelayMs`.
 *
 * Kept to 4xx deliberately. A 5xx is the server in trouble, and probing a
 * struggling server every second is how it stays in trouble; an error with no
 * status never reached the server at all, so nothing about it says the
 * resource is merely early. 429 is its own outcome kind and never arrives
 * here, which matters — a rate limit is the one thing that must always back
 * off.
 *
 * This is a judgement about a status code nobody has observed from a
 * too-early booking, because the site cannot be reached from a test run. It
 * is the safe side of the bet either way: guessing wrong costs roughly forty
 * bounded requests instead of a dozen, and the outcome is the same failure.
 */
function isNotThereYet(outcome: AttemptOutcome): boolean {
  if (outcome.kind === 'too-early') return true;
  if (outcome.kind !== 'error' || outcome.status === undefined) return false;
  return outcome.status >= 400 && outcome.status < 500;
}

/**
 * Returned by `runBounded` when its own timer, not the attempt, won the race.
 *
 * Kept distinct from any `AttemptOutcome`: the attempt was cut off with nothing
 * to report, which is a different event from the attempt *returning* an error.
 * Conflating them is the bug this symbol exists to prevent — a class that never
 * lists spends the whole budget on `too-early` probes, and if the final probe
 * is still in flight when the timer fires, the run must still be reported as
 * "never appeared", not as a raw `error` carrying an internal "attempt aborted"
 * string that reads to the user as a hard failure.
 */
const BUDGET_SPENT = Symbol('budget-spent');

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
): Promise<AttemptOutcome | typeof BUDGET_SPENT> {
  const controller = new AbortController();
  let cancelTimer: (() => void) | undefined;

  const timeout = new Promise<typeof BUDGET_SPENT>((resolve) => {
    cancelTimer = setTimer(() => {
      controller.abort();
      resolve(BUDGET_SPENT);
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
  // The last outcome an attempt actually *produced*. Stays null until one does,
  // so a budget that expires before any attempt completes is reported as its
  // own thing rather than as a stale placeholder.
  let last: AttemptOutcome | null = null;

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { outcome: last ?? noResponse(options.budgetMs), attempts, exhausted: true };
    }

    attempts += 1;
    const outcome = await runBounded(attempt, remaining, setTimer);

    if (outcome === BUDGET_SPENT) {
      // Our own timer cut the attempt short — the deadline has effectively
      // arrived. Report the last real outcome (usually `too-early`), not the
      // abort, but still log the attempt so a cut-off run is visible.
      options.onAttempt?.(attempts, {
        kind: 'error',
        detail: `attempt aborted: exceeded the remaining ${remaining}ms budget`,
      });
      return { outcome: last ?? noResponse(options.budgetMs), attempts, exhausted: true };
    }

    last = outcome;
    options.onAttempt?.(attempts, outcome);

    if (!isRetryable(outcome)) {
      return { outcome, attempts, exhausted: false };
    }

    // "Not there yet" gets the tight probe cap; everything else — a rate
    // limit, a server error, a request that never landed — is something
    // asking to be left alone, and keeps the full exponential backoff.
    const maxDelayMs =
      isNotThereYet(outcome) && options.pollMaxDelayMs !== undefined
        ? Math.min(options.pollMaxDelayMs, options.maxDelayMs)
        : options.maxDelayMs;
    const delay = backoffDelayMs(
      attempts,
      { baseDelayMs: options.baseDelayMs, maxDelayMs },
      retryAfterOf(outcome),
      random,
    );
    if (now() + delay >= deadline) {
      return { outcome, attempts, exhausted: true };
    }

    options.onWait?.(attempts, delay);
    await sleep(delay);
  }
}

/** The outcome when the budget ran out before a single attempt came back. */
function noResponse(budgetMs: number): AttemptOutcome {
  return { kind: 'error', detail: `no response from Elixia within the ${budgetMs}ms budget` };
}
