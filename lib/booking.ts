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
import { ClassNotListedError } from './types';
import type { AttemptOutcome, BookingConfig, PlannedBooking, StoredTokens } from './types';

export interface BookingDeps {
  /** Issues the actual request. Injected so tests never touch the network. */
  book: (
    tokens: StoredTokens,
    classId: string,
    signal?: AbortSignal,
  ) => Promise<AttemptOutcome>;
  /**
   * Resolves the desired class to Elixia's own id, by fetching the schedule.
   *
   * Expected to fail with `ClassNotListedError` until the booking window
   * opens: Elixia does not list a class at all before then (docs/api.md §4).
   * That is why this is attempted twice — once early, once at T-0 — rather
   * than treated as a fatal error the first time.
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
  //
  // Resolving early is an optimisation, not a precondition. A class outside
  // its booking window is absent from the schedule entirely (docs/api.md §4),
  // so this attempt legitimately fails whenever the window has not opened yet
  // — and whether it has depends on a release granularity Elixia does not
  // publish. Failing softly here and resolving again after the sleep keeps the
  // critical path to a single request in the common case, without depending on
  // an answer nobody has.
  let classId: string | null = null;
  try {
    classId = await deps.resolveClassId(planned);
    logger.log('class.resolved', { classId, when: 'before-sleep' });
  } catch (err) {
    logger.log('class.unresolved', {
      when: 'before-sleep',
      reason: (err as Error).message,
    });
  }

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

  const runAttempt = async (signal: AbortSignal): Promise<AttemptOutcome> => {
    if (firstAttemptOffsetMs === null) {
      firstAttemptOffsetMs = now() - planned.releaseEpochMs;
    }

    // The class appears on the schedule the moment booking opens, so *not being
    // listed* is "not open yet" rather than a failure — retryable, with the
    // budget bounding how long we keep looking. Any other lookup failure (an
    // unknown centre, a changed page, a dead connection) is reported as the
    // error it is: retrying those for 30s and then blaming the timing would
    // send someone hunting a race that never happened.
    if (classId === null) {
      try {
        classId = await deps.resolveClassId(planned);
        logger.log('class.resolved', { classId, when: 'at-release' });
      } catch (err) {
        const reason = (err as Error).message;
        logger.log('class.unresolved', { when: 'at-release', reason });
        return err instanceof ClassNotListedError
          ? { kind: 'too-early' }
          : { kind: 'error', detail: `could not look up the class: ${reason}` };
      }
    }

    if (deps.dryRun) {
      logger.log('attempt.dry-run', { classId });
      return { kind: 'booked', bookingId: 'DRY-RUN' };
    }

    return deps.book(deps.tokens, classId, signal);
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

  // No waitlist follow-up: one call to /api/book either books the class or
  // places you on its waiting list, and both are already success (docs/api.md
  // §6). There is nothing left to try.
  logger.log('booking.done', {
    outcome: result.outcome.kind,
    attempts: result.attempts,
    exhausted: result.exhausted,
    firstAttemptOffsetMs,
  });

  return {
    planned,
    outcome: result.outcome,
    attempts: result.attempts,
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
      return outcome.position === undefined
        ? `${prefix}🕒 Waitlisted ${what}${timing}`
        : `${prefix}🕒 Waitlisted (#${outcome.position}) ${what}${timing}`;
    // Elixia cannot tell "you already booked this" apart from "you hold a
    // different class at the same time", so neither can this message.
    case 'already-booked':
      return `${prefix}ℹ️ Skipped ${what} — you already have an overlapping booking${
        outcome.detail ? ` (${outcome.detail})` : ''
      }`;
    case 'unauthorized':
      return `${prefix}🚨 Elixia refused to book ${what} — ${outcome.detail}`;
    case 'too-early':
      return `${prefix}❌ Never appeared on the schedule in time: ${what}${timing} after ${report.attempts} attempts`;
    case 'rate-limited':
      return `${prefix}❌ Rate limited booking ${what} after ${report.attempts} attempts`;
    case 'error':
      return `${prefix}❌ Failed ${what}: ${outcome.detail}`;
  }
}
