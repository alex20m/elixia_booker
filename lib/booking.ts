/**
 * The critical path: wait for T-0, then book.
 *
 * Ordering here is the whole design. Everything that can be done early — token
 * refresh, resolving the class id — happens *before* the sleep, so the only
 * thing standing between the release instant and the POST is one network hop.
 * Any work left until after the sleep is time spent losing the race.
 */

import { retryWithBackoff, defaultSleep, type RetryResult } from './retry';
import type { Logger } from './logger';
import type { AttemptOutcome, BookingConfig, PlannedBooking, StoredTokens } from './types';

export interface BookingDeps {
  /** Issues the actual request. Injected so tests never touch the network. */
  book: (
    tokens: StoredTokens,
    classId: string,
    waitlist: boolean,
    signal?: AbortSignal,
  ) => Promise<AttemptOutcome>;
  /**
   * Resolves the desired class to Elixia's own id. May need a schedule fetch;
   * whether that can happen before the class is released is an open question in
   * docs/api.md §4.
   */
  resolveClassId: (planned: PlannedBooking) => Promise<string>;
  tokens: StoredTokens;
  logger: Logger;
  config: BookingConfig;
  dryRun: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * Wall-clock instant this run must finish by, if the host imposes one.
   *
   * Serverless platforms kill a function at its maxDuration, so a retry budget
   * that ignores that would simply be truncated mid-attempt — the process
   * vanishes, the history row never gets written, and the log stops mid-story.
   * Clamping instead means the loop ends on its own terms and always records
   * what happened.
   */
  deadlineMs?: number;
}

export interface BookingReport {
  planned: PlannedBooking;
  outcome: AttemptOutcome;
  attempts: number;
  exhausted: boolean;
  /** How far from T-0 the first request went out. Negative is early. */
  firstAttemptOffsetMs: number | null;
  dryRun: boolean;
}

/** Outcomes that mean the slot is secured; everything else is a miss. */
export function isSuccess(outcome: AttemptOutcome): boolean {
  return (
    outcome.kind === 'booked' ||
    outcome.kind === 'waitlisted' ||
    outcome.kind === 'already-booked'
  );
}

export async function executeBooking(
  planned: PlannedBooking,
  deps: BookingDeps,
): Promise<BookingReport> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { logger, config } = deps;

  logger.setTarget(planned.releaseEpochMs);
  logger.log('booking.start', {
    class: planned.desired.className,
    center: planned.desired.center,
    classDate: planned.classDate,
    classStart: new Date(planned.classEpochMs).toISOString(),
    releaseAt: new Date(planned.releaseEpochMs).toISOString(),
    dryRun: deps.dryRun,
    ...(planned.releaseNote ? { releaseNote: planned.releaseNote } : {}),
  });

  // --- Everything below the sleep must be as thin as possible. -------------
  const classId = await deps.resolveClassId(planned);
  logger.log('class.resolved', { classId });

  const fireAt = planned.releaseEpochMs - config.leadMs;
  const waitMs = fireAt - now();
  if (waitMs > 0) {
    logger.log('sleep.begin', { waitMs, fireAt: new Date(fireAt).toISOString() });
    await sleep(waitMs);
  } else {
    // Late arrival is recoverable — fire immediately rather than skipping.
    logger.log('sleep.skipped', { lateByMs: -waitMs });
  }

  let firstAttemptOffsetMs: number | null = null;
  let sawFull = false;

  const runAttempt = async (signal: AbortSignal): Promise<AttemptOutcome> => {
    if (firstAttemptOffsetMs === null) {
      firstAttemptOffsetMs = now() - planned.releaseEpochMs;
    }

    // Fall back to the waitlist only after the class is confirmed full, and
    // only if asked to. Requesting the waitlist speculatively would forfeit a
    // place that might still be bookable.
    const useWaitlist = sawFull && planned.desired.onFull === 'waitlist';

    if (deps.dryRun) {
      logger.log('attempt.dry-run', { classId, waitlist: useWaitlist });
      return { kind: 'booked', bookingId: 'DRY-RUN' };
    }

    const outcome = await deps.book(deps.tokens, classId, useWaitlist, signal);
    if (outcome.kind === 'full') sawFull = true;
    return outcome;
  };

  // Whatever is left after the sleep, never more than the configured budget.
  const budgetMs =
    deps.deadlineMs === undefined
      ? config.retryBudgetMs
      : Math.max(0, Math.min(config.retryBudgetMs, deps.deadlineMs - now()));

  if (budgetMs < config.retryBudgetMs) {
    logger.log('budget.clamped', { budgetMs, configured: config.retryBudgetMs });
  }

  const result: RetryResult = await retryWithBackoff(runAttempt, {
    budgetMs,
    baseDelayMs: config.retryBaseDelayMs,
    maxDelayMs: config.retryMaxDelayMs,
    now,
    sleep,
    ...(deps.random ? { random: deps.random } : {}),
    onAttempt: (attempt, outcome) => logger.log('attempt.result', { attempt, ...outcome }),
    onWait: (attempt, delayMs) => logger.log('attempt.backoff', { attempt, delayMs }),
  });

  // A full class with onFull: 'waitlist' needs one more request — the retry
  // loop stopped because 'full' is final for booking, but the waitlist is a
  // different call and has not been tried yet.
  let finalOutcome = result.outcome;
  let attempts = result.attempts;

  if (finalOutcome.kind === 'full' && planned.desired.onFull === 'waitlist' && !deps.dryRun) {
    logger.log('waitlist.attempt', { classId });
    finalOutcome = await deps.book(deps.tokens, classId, true);
    attempts += 1;
    logger.log('waitlist.result', { ...finalOutcome });
  }

  logger.log('booking.done', {
    outcome: finalOutcome.kind,
    attempts,
    exhausted: result.exhausted,
    firstAttemptOffsetMs,
  });

  return {
    planned,
    outcome: finalOutcome,
    attempts,
    exhausted: result.exhausted,
    firstAttemptOffsetMs,
    dryRun: deps.dryRun,
  };
}

/** One-line human summary for Telegram. */
export function describeReport(report: BookingReport): string {
  const { planned, outcome } = report;
  const what = `${planned.desired.className} @ ${planned.desired.center}, ${planned.classDate} ${planned.desired.startTime}`;
  const timing =
    report.firstAttemptOffsetMs === null
      ? ''
      : ` (fired ${report.firstAttemptOffsetMs >= 0 ? '+' : ''}${report.firstAttemptOffsetMs}ms from T-0)`;
  const prefix = report.dryRun ? '[DRY RUN] ' : '';

  switch (outcome.kind) {
    case 'booked':
      return `${prefix}✅ Booked ${what}${timing}`;
    case 'waitlisted':
      return `${prefix}🕒 Waitlisted ${what}${timing}`;
    case 'already-booked':
      return `${prefix}ℹ️ Already booked: ${what}`;
    case 'full':
      return `${prefix}❌ Full: ${what}${timing}`;
    case 'unauthorized':
      return `${prefix}🚨 Session rejected booking ${what} — ${outcome.detail}`;
    case 'too-early':
      return `${prefix}❌ Never opened in time: ${what}${timing} after ${report.attempts} attempts`;
    case 'rate-limited':
      return `${prefix}❌ Rate limited booking ${what} after ${report.attempts} attempts`;
    case 'error':
      return `${prefix}❌ Failed ${what}: ${outcome.detail}`;
  }
}
