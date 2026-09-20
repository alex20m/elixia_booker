/**
 * The critical path: wait for T-0, then book.
 *
 * Ordering here is the whole design. Everything that can be done early — token
 * refresh, resolving the class id — happens *before* the sleep, so the only
 * thing standing between the release instant and the POST is one network hop.
 * Any work left until after the sleep is time spent losing the race.
 *
 * "Early" is two moments, not one. A class is absent from the schedule until
 * its window opens (docs/api.md §4), so the resolve at the top of the run
 * usually finds nothing; a second, unawaited probe fires a moment before T-0,
 * where it can both catch a window that opened during the wait and warm a
 * connection that has long since been closed for idleness. Whatever is still
 * unresolved when the race starts is resolved inside it — and that probing is
 * paced tightly on purpose, because the gap between two probes is the lateness
 * everyone pays once the class does appear. See `listingPollMaxDelayMs`.
 */

import { retryWithBackoff, defaultSleep, type RetryResult } from './retry';
import type { Logger } from './logger';
import { ClassNotListedError } from './types';
import type {
  AttemptOutcome,
  BookingConfig,
  PlannedBooking,
  ResolvedClass,
  StoredTokens,
} from './types';

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
  resolveClassId: (planned: PlannedBooking) => Promise<ResolvedClass>;
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
  /**
   * How far from T-0 the run *woke up and began work*. Negative is early.
   *
   * Not when anything was asked of Elixia. It is stamped at the top of the
   * first attempt, before the class is looked up, so it measures the sleep's
   * accuracy and nothing else. Two runs that both wake at +1ms can still
   * reach the booking endpoint a second apart — see `bookRequestOffsetMs`,
   * which is the number that decides who gets the place.
   */
  firstAttemptOffsetMs: number | null;
  /**
   * How far from T-0 the booking request that produced this outcome was
   * issued. Negative is early, null when no request was ever sent.
   *
   * This is the one that matters. Everything between waking and here — the
   * schedule fetch that resolves the class id, its parse, any retry rounds
   * spent waiting for the class to be listed — is time other people are
   * using to book, and none of it shows up in `firstAttemptOffsetMs`.
   */
  bookRequestOffsetMs: number | null;
  dryRun: boolean;
  /**
   * How long the class actually runs, read off the same schedule match that
   * resolved its id. Absent when the class never resolved at all — nothing
   * with a duration to record was ever found.
   */
  durationMin?: number;
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
  let durationMin: number | undefined;

  /**
   * Take a resolution, unless one is already in hand, and report the id in
   * force either way.
   *
   * The guard matters now that a resolution can arrive from a probe running
   * alongside the race: whichever lands first is the one the booking request
   * uses, and a straggler must not swap the id out from under it.
   */
  const adopt = (resolved: ResolvedClass, when: string): string => {
    if (classId !== null) return classId;
    ({ classId, durationMin } = resolved);
    logger.log('class.resolved', { classId, durationMin, when });
    return resolved.classId;
  };

  try {
    void adopt(await deps.resolveClassId(planned), 'before-sleep');
  } catch (err) {
    logger.log('class.unresolved', {
      when: 'before-sleep',
      reason: (err as Error).message,
    });
  }

  const fireAt = planned.releaseEpochMs - config.leadMs;

  // --- One last look, moments before firing. -------------------------------
  //
  // Only when the early attempt came back empty, which is the normal case: a
  // class is absent from the schedule until its window opens. Two things are
  // being bought here, and both of them come off the critical path.
  //
  // Elixia publishes no release time at all (docs/api.md §4), so `fireAt` is
  // computed, not read — a class whose window opened during the wait is found
  // here rather than costing a full schedule fetch at T-0, which turns the
  // race into a bare POST. And by this point the run has been idle for tens
  // of seconds, comfortably longer than an HTTP keep-alive, so the socket to
  // Elixia is gone; opening it now means the booking request is not also
  // paying for a TCP and TLS handshake at the one instant that matters.
  //
  // Deliberately *not* awaited. A probe that hangs must cost the race
  // nothing: the whole point of doing this early is that T-0 arrives on time
  // regardless, and an awaited probe on a stalled connection would push the
  // booking request past the instant it exists to hit. It is fire-and-forget
  // with its rejection handled, and whatever it finds is picked up by
  // `adopt`, or not, before the attempt below reads `classId`.
  const preflightAt = fireAt - config.preflightMs;
  if (classId === null && preflightAt > now()) {
    const preflightWaitMs = preflightAt - now();
    logger.log('sleep.begin', {
      waitMs: preflightWaitMs,
      fireAt: new Date(preflightAt).toISOString(),
      reason: 'preflight',
    });
    await sleep(preflightWaitMs);

    logger.log('class.preflight');
    void deps
      .resolveClassId(planned)
      .then((resolved) => void adopt(resolved, 'preflight'))
      .catch((err: unknown) =>
        logger.log('class.unresolved', {
          when: 'preflight',
          reason: (err as Error).message,
        }),
      );
  }

  const waitMs = fireAt - now();
  if (waitMs > 0) {
    logger.log('sleep.begin', { waitMs, fireAt: new Date(fireAt).toISOString() });
    await sleep(waitMs);
  } else {
    // Late arrival is recoverable — fire immediately rather than skipping.
    logger.log('sleep.skipped', { lateByMs: -waitMs });
  }

  let firstAttemptOffsetMs: number | null = null;
  // Overwritten by each request, so it ends up holding the one whose outcome
  // was final — the request that actually won or lost the place.
  let bookRequestOffsetMs: number | null = null;

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
    // Read once: the preflight probe may still be in flight and can fill
    // `classId` mid-attempt, and an attempt that resolved its own id must
    // book *that* id rather than re-reading a field that changed underneath.
    let id = classId;
    if (id === null) {
      try {
        id = adopt(await deps.resolveClassId(planned), 'at-release');
      } catch (err) {
        const reason = (err as Error).message;
        logger.log('class.unresolved', { when: 'at-release', reason });
        return err instanceof ClassNotListedError
          ? { kind: 'too-early' }
          : { kind: 'error', detail: `could not look up the class: ${reason}` };
      }
    }

    // Stamped here, not after the call returns: the question is when the
    // request went out relative to everyone else's, not how long Elixia took
    // to answer it.
    bookRequestOffsetMs = now() - planned.releaseEpochMs;

    if (deps.dryRun) {
      logger.log('attempt.dry-run', { classId: id, bookRequestOffsetMs });
      return { kind: 'booked', bookingId: 'DRY-RUN' };
    }

    return deps.book(deps.tokens, id, signal);
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
    pollMaxDelayMs: config.listingPollMaxDelayMs,
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
    bookRequestOffsetMs,
  });

  return {
    planned,
    outcome: result.outcome,
    attempts: result.attempts,
    exhausted: result.exhausted,
    firstAttemptOffsetMs,
    bookRequestOffsetMs,
    dryRun: deps.dryRun,
    ...(durationMin !== undefined ? { durationMin } : {}),
  };
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "2026-09-13" -> "Sat 13 Sep".
 *
 * Day before month, because these messages are read in Finland. The weekday
 * is not decoration: a booking is made a week or two ahead, and the weekday
 * is what tells someone at a glance that it is the class they meant rather
 * than the same class on another day.
 *
 * Parsed as UTC midnight and read back in UTC, so the calendar day that comes
 * out is the one in the string. Anything zone-aware here can land a day off,
 * and a message naming the wrong day is worse than one naming no day at all.
 */
function friendlyDate(classDate: string): string {
  const [year, month, day] = classDate.split('-').map(Number);
  const weekday = SHORT_WEEKDAYS[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()];
  return `${weekday} ${day} ${SHORT_MONTHS[month! - 1]}`;
}

/** "09:30" -> "9.30", and "14:00" -> "14.00". */
function friendlyTime(startTime: string): string {
  const [hour, minute] = startTime.split(':');
  return `${Number(hour)}.${minute}`;
}

/**
 * The message a person actually reads, on Telegram or in an email.
 *
 * Deliberately carries no timings, attempt counts, offsets or provider error
 * text. All of that is recorded and shown on the Activity page, which is
 * where someone goes to ask *why* an attempt went the way it did; a
 * notification only has to say what happened and, where there is one, what to
 * do about it. Mixing the two made the one line most people ever see read as
 * machine output — and, worse, the offset it quoted was measured before the
 * booking request was even sent, so it was a technical number that was also
 * wrong.
 *
 * Where there is advice, it goes on a second line rather than a second
 * sentence. `subjectFor` in lib/notify.ts takes the first line as the email
 * subject, so this keeps the headline short enough to survive a subject line
 * while the body still carries both.
 */
export function describeReport(report: BookingReport): string {
  const { planned, outcome } = report;
  const what = `${planned.desired.className} at ${planned.desired.center} on ${friendlyDate(
    planned.classDate,
  )} at ${friendlyTime(planned.desired.startTime)}`;
  const prefix = report.dryRun ? '[DRY RUN] ' : '';

  switch (outcome.kind) {
    case 'booked':
      return `${prefix}✅ Booked ${what}`;
    case 'waitlisted':
      return outcome.position === undefined
        ? `${prefix}🕒 You're on the waitlist for ${what}`
        : `${prefix}🕒 You're number ${outcome.position} on the waitlist for ${what}`;
    // Elixia cannot tell "you already booked this" apart from "you hold a
    // different class at the same time", so neither can this message.
    case 'already-booked':
      return `${prefix}ℹ️ Didn't book ${what} — you already have a booking at that time.`;
    case 'unauthorized':
      return (
        `${prefix}🚨 Elixia wouldn't accept your saved login, so ${what} wasn't booked.\n` +
        `Re-link your Elixia account in the app to start booking again.`
      );
    case 'too-early':
      return (
        `${prefix}❌ ${what} never opened for booking, so nothing was booked.\n` +
        `It's worth checking the Elixia app in case the class has moved.`
      );
    case 'rate-limited':
      return `${prefix}❌ Elixia was turning requests away, so ${what} wasn't booked.`;
    case 'error':
      return (
        `${prefix}❌ Something went wrong booking ${what}.\n` +
        `The Activity page in the app has the details.`
      );
  }
}
