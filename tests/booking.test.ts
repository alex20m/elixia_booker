import { describe, expect, it, vi } from 'vitest';
import { describeReport, executeBooking, isSuccess } from '../lib/booking';
import { Logger } from '../lib/logger';
import { ClassNotListedError } from '../lib/types';
import type { AttemptOutcome, BookingConfig, PlannedBooking, StoredTokens } from '../lib/types';

const RELEASE = Date.parse('2026-08-11T06:00:00Z');

const config: BookingConfig = {
  timeZone: 'Europe/Helsinki',
  bookingWindowDays: 7,
  leadMs: 0,
  retryBudgetMs: 30_000,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 5_000,
  claimHorizonMs: 90_000,
  claimGraceMs: 120_000,
  classes: [],
};

const planned: PlannedBooking = {
  desired: {
    id: 'bodypump-tue-0900',
    center: 'tapiola',
    className: 'Bodypump',
    weekday: 'tuesday',
    startTime: '09:00',
    priority: 1,
  },
  releaseEpochMs: RELEASE,
  classEpochMs: Date.parse('2026-08-18T06:00:00Z'),
  classDate: '2026-08-18',
};

const tokens: StoredTokens = {
  accessToken: 'a',
  expiresAtMs: RELEASE + 3_600_000,
  updatedAtMs: RELEASE,
};

function harness(startMs: number) {
  let nowMs = startMs;
  const slept: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      slept.push(ms);
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    slept,
  };
}

function deps(overrides: Partial<Parameters<typeof executeBooking>[1]> = {}) {
  const clock = harness(RELEASE - 60_000);
  return {
    clock,
    built: {
      book: vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'booked', bookingId: '1' })),
      resolveClassId: vi.fn(async () => 'class-77'),
      tokens,
      logger: new Logger(clock.now),
      config,
      dryRun: false,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      ...overrides,
    },
  };
}

describe('executeBooking', () => {
  it('sleeps until the release instant, then books', async () => {
    const { clock, built } = deps();

    const report = await executeBooking(planned, built);

    expect(clock.slept).toContain(60_000);
    expect(report.outcome).toEqual({ kind: 'booked', bookingId: '1' });
    expect(report.firstAttemptOffsetMs).toBe(0);
  });

  it('resolves the class id before sleeping, not at T-0', async () => {
    // Anything left until after the sleep is time spent losing the race.
    const order: string[] = [];
    const clock = harness(RELEASE - 60_000);
    const built = {
      book: vi.fn(async (): Promise<AttemptOutcome> => {
        order.push('book');
        return { kind: 'booked' };
      }),
      resolveClassId: vi.fn(async () => {
        order.push('resolve');
        return 'class-77';
      }),
      tokens,
      logger: new Logger(clock.now),
      config,
      dryRun: false,
      now: clock.now,
      sleep: async (ms: number) => {
        order.push('sleep');
        clock.advance(ms);
      },
      random: () => 0.5,
    };

    await executeBooking(planned, built);

    expect(order).toEqual(['resolve', 'sleep', 'book']);
  });

  it('fires immediately when the run arrives after the release instant', async () => {
    const clock = harness(RELEASE + 5_000);
    const { built } = deps({ now: clock.now, sleep: clock.sleep, logger: new Logger(clock.now) });

    const report = await executeBooking(planned, built);

    expect(clock.slept).toHaveLength(0); // no sleep at all — it was already late
    expect(report.firstAttemptOffsetMs).toBe(5_000);
  });

  it('honours leadMs by firing early', async () => {
    const { clock, built } = deps({ config: { ...config, leadMs: 300 } });

    const report = await executeBooking(planned, built);

    expect(clock.slept).toContain(59_700);
    expect(report.firstAttemptOffsetMs).toBe(-300);
  });

  it('retries a too-early rejection and reports the winning attempt', async () => {
    const outcomes: AttemptOutcome[] = [
      { kind: 'too-early' },
      { kind: 'too-early' },
      { kind: 'booked', bookingId: '9' },
    ];
    const { built } = deps({ book: vi.fn(async () => outcomes.shift()!) });

    const report = await executeBooking(planned, built);

    expect(report.outcome).toEqual({ kind: 'booked', bookingId: '9' });
    expect(report.attempts).toBe(3);
  });

  it('retries resolution at T-0 when the class was not listed yet, then books it', async () => {
    // A class is absent from Elixia's schedule until its window opens
    // (docs/api.md §4), so the pre-sleep resolve legitimately fails. Giving up
    // there would miss every booking whose window opens at the release instant.
    const resolveClassId = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ClassNotListedError('not listed yet'))
      .mockResolvedValueOnce('class-77');
    const { built } = deps({ resolveClassId });

    const report = await executeBooking(planned, built);

    expect(resolveClassId).toHaveBeenCalledTimes(2);
    expect(built.book).toHaveBeenCalledWith(tokens, 'class-77', expect.anything());
    expect(report.outcome.kind).toBe('booked');
  });

  it('keeps retrying while the class stays unlisted, and never books a guess', async () => {
    const resolveClassId = vi.fn(async () => {
      throw new ClassNotListedError('not listed yet');
    });
    const { built } = deps({ resolveClassId });

    const report = await executeBooking(planned, built);

    expect(built.book).not.toHaveBeenCalled();
    expect(report.outcome.kind).toBe('too-early');
    expect(report.attempts).toBeGreaterThan(1);
  });

  it('reports a real lookup failure as an error, not as "never opened in time"', async () => {
    // A mistyped centre never resolves however long you wait. Calling that
    // "too early" would send someone hunting a race that never happened.
    const resolveClassId = vi.fn(async () => {
      throw new Error('No Elixia centre named "Atlantis"');
    });
    const { built } = deps({ resolveClassId });

    const report = await executeBooking(planned, built);

    expect(report.outcome.kind).toBe('error');
    expect((report.outcome as { detail: string }).detail).toMatch(/Atlantis/);
  });

  it('does not re-resolve once it has an id, so retries cost one request each', async () => {
    const outcomes: AttemptOutcome[] = [{ kind: 'too-early' }, { kind: 'booked' }];
    const resolveClassId = vi.fn(async () => 'class-77');
    const { built } = deps({ resolveClassId, book: vi.fn(async () => outcomes.shift()!) });

    await executeBooking(planned, built);

    expect(resolveClassId).toHaveBeenCalledTimes(1);
  });

  it('accepts a waiting-list place as the final answer, without a second request', async () => {
    // Elixia books or waitlists in the one call (docs/api.md §6). A follow-up
    // request would at best duplicate the placement.
    const book = vi.fn(
      async (): Promise<AttemptOutcome> => ({ kind: 'waitlisted', position: 2 }),
    );
    const { built } = deps({ book });

    const report = await executeBooking(planned, built);

    expect(book).toHaveBeenCalledTimes(1);
    expect(report.outcome).toEqual({ kind: 'waitlisted', position: 2 });
  });

  it('stops on an overlapping booking instead of retrying it', async () => {
    const book = vi.fn(
      async (): Promise<AttemptOutcome> => ({ kind: 'already-booked', detail: 'overlap' }),
    );
    const { built } = deps({ book });

    const report = await executeBooking(planned, built);

    expect(book).toHaveBeenCalledTimes(1);
    expect(report.outcome.kind).toBe('already-booked');
  });

  it('stops on an expired session instead of retrying into a wall', async () => {
    const book = vi.fn(
      async (): Promise<AttemptOutcome> => ({ kind: 'unauthorized', detail: 'HTTP 401' }),
    );
    const { built } = deps({ book });

    const report = await executeBooking(planned, built);

    expect(book).toHaveBeenCalledTimes(1);
    expect(report.outcome.kind).toBe('unauthorized');
  });

  it('logs every attempt with an offset from T-0', async () => {
    const outcomes: AttemptOutcome[] = [{ kind: 'too-early' }, { kind: 'booked' }];
    const { built } = deps({ book: vi.fn(async () => outcomes.shift()!) });

    await executeBooking(planned, built);

    const events = built.logger.all().map((e) => e.event);
    expect(events).toContain('booking.start');
    expect(events).toContain('sleep.begin');
    expect(events).toContain('attempt.result');
    expect(events).toContain('booking.done');
    // Offsets are what make a miss diagnosable after the fact.
    for (const entry of built.logger.all()) {
      expect(entry.offsetMs).toBeTypeOf('number');
    }
  });
});

describe('executeBooking under a host deadline', () => {
  it('stops at the deadline rather than running the full retry budget', async () => {
    // Serverless platforms kill the function at maxDuration. If the loop
    // ignored that, it would be cut off mid-attempt: no history row, no
    // notification, and a log that just stops. Ending on our own terms is what
    // makes the outcome recordable.
    const { clock, built } = deps({
      book: vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'too-early' })),
    });

    const report = await executeBooking(planned, {
      ...built,
      deadlineMs: RELEASE + 2_000,
    });

    // The configured budget is 30s; the deadline is 2s after T-0.
    expect(clock.now() - RELEASE).toBeLessThanOrEqual(2_000);
    expect(report.exhausted).toBe(true);
    expect(report.outcome.kind).toBe('too-early');
  });

  it('uses the full budget when the deadline is comfortably far off', async () => {
    const { clock, built } = deps({
      book: vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'too-early' })),
    });

    await executeBooking(planned, { ...built, deadlineMs: RELEASE + 10 * 60_000 });

    // Ran the real 30s budget rather than being clamped down to nothing.
    expect(clock.now() - RELEASE).toBeGreaterThan(20_000);
  });

  it('records the clamp so a short run is explainable afterwards', async () => {
    const { built } = deps({
      book: vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'too-early' })),
    });

    await executeBooking(planned, { ...built, deadlineMs: RELEASE + 2_000 });

    expect(built.logger.all().map((e) => e.event)).toContain('budget.clamped');
  });
});

describe('executeBooking in dry-run mode', () => {
  it('does everything except issue the booking request', async () => {
    const book = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'booked' }));
    const { clock, built } = deps({ book, dryRun: true });

    const report = await executeBooking(planned, built);

    expect(book).not.toHaveBeenCalled();
    // …but the timing path still ran, which is the point of a dry run.
    expect(built.resolveClassId).toHaveBeenCalled();
    expect(clock.slept).toContain(60_000);
    expect(report.dryRun).toBe(true);
    expect(report.outcome).toEqual({ kind: 'booked', bookingId: 'DRY-RUN' });
  });

  it('does not book even when the class would have been waitlisted', async () => {
    const book = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'waitlisted' }));
    const { built } = deps({ book, dryRun: true });

    await executeBooking(planned, built);

    expect(book).not.toHaveBeenCalled();
  });
});

describe('isSuccess', () => {
  it.each([
    ['booked', true],
    ['waitlisted', true],
    ['already-booked', true],
    ['too-early', false],
    ['unauthorized', false],
    ['error', false],
  ] as const)('%s -> %s', (kind, expected) => {
    expect(isSuccess({ kind, detail: '' } as unknown as AttemptOutcome)).toBe(expected);
  });
});

describe('describeReport', () => {
  const base = {
    planned,
    attempts: 1,
    exhausted: false,
    firstAttemptOffsetMs: 42,
    dryRun: false,
  };

  it('names the class, date and timing on success', () => {
    const text = describeReport({ ...base, outcome: { kind: 'booked' } });
    expect(text).toContain('Bodypump');
    expect(text).toContain('2026-08-18');
    expect(text).toContain('+42ms');
  });

  it('marks a dry run so it cannot be mistaken for a real booking', () => {
    const text = describeReport({ ...base, dryRun: true, outcome: { kind: 'booked' } });
    expect(text).toContain('[DRY RUN]');
  });

  it('surfaces the detail of an auth failure', () => {
    const text = describeReport({
      ...base,
      outcome: { kind: 'unauthorized', detail: 'HTTP 401 token expired' },
    });
    expect(text).toContain('HTTP 401 token expired');
  });

  it('shows a negative offset when the request went out early', () => {
    const text = describeReport({
      ...base,
      firstAttemptOffsetMs: -300,
      outcome: { kind: 'booked' },
    });
    expect(text).toContain('-300ms');
  });
});
