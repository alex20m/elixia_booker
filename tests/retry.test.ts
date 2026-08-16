import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, retryWithBackoff } from '../lib/retry';
import { isRetryable } from '../lib/types';
import type { AttemptOutcome } from '../lib/types';

/** A controllable clock, so tests assert on the budget rather than on real time. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    get value() {
      return nowMs;
    },
  };
}

const opts = { budgetMs: 30_000, baseDelayMs: 250, maxDelayMs: 5_000 };

describe('isRetryable', () => {
  it.each([
    ['too-early', true],
    ['rate-limited', true],
    ['error', true],
    ['booked', false],
    ['waitlisted', false],
    ['already-booked', false],
    ['full', false],
    ['unauthorized', false],
  ] as const)('%s -> retryable=%s', (kind, expected) => {
    const outcome = { kind, detail: 'x' } as unknown as AttemptOutcome;
    expect(isRetryable(outcome)).toBe(expected);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially across attempts', () => {
    // random() = 1 gives the top of the jitter band, making the growth visible.
    const at = (n: number): number => backoffDelayMs(n, opts, undefined, () => 1);
    expect(at(1)).toBe(250);
    expect(at(2)).toBe(500);
    expect(at(3)).toBe(1000);
    expect(at(4)).toBe(2000);
  });

  it('caps at maxDelayMs however many attempts have passed', () => {
    expect(backoffDelayMs(20, opts, undefined, () => 1)).toBe(5000);
  });

  it('jitters within the upper half of the band', () => {
    // Never zero — a floor keeps retries from collapsing into a burst.
    expect(backoffDelayMs(3, opts, undefined, () => 0)).toBe(500);
    expect(backoffDelayMs(3, opts, undefined, () => 1)).toBe(1000);
  });

  it('obeys a server-supplied Retry-After over its own backoff', () => {
    expect(backoffDelayMs(1, opts, 3_000, () => 1)).toBe(3000);
  });

  it('clamps an excessive Retry-After to maxDelayMs', () => {
    // A header must not be able to park the Worker past its budget.
    expect(backoffDelayMs(1, opts, 600_000, () => 1)).toBe(5000);
  });
});

describe('retryWithBackoff', () => {
  it('returns immediately on a successful first attempt', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'booked' }));

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 0.5 });

    expect(result.outcome.kind).toBe('booked');
    expect(result.attempts).toBe(1);
    expect(result.exhausted).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a too-early response until it succeeds', async () => {
    const clock = fakeClock();
    const outcomes: AttemptOutcome[] = [
      { kind: 'too-early' },
      { kind: 'too-early' },
      { kind: 'booked', bookingId: '5' },
    ];
    const attempt = vi.fn(async () => outcomes.shift()!);

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 0.5 });

    expect(result.outcome).toEqual({ kind: 'booked', bookingId: '5' });
    expect(result.attempts).toBe(3);
    expect(result.exhausted).toBe(false);
  });

  it('stops immediately when the class is full, without retrying', async () => {
    // Full does not become un-full inside 30s; retrying is pure hammering.
    const clock = fakeClock();
    const attempt = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'full' }));

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 0.5 });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe('full');
    expect(result.exhausted).toBe(false);
  });

  it('stops immediately on an expired session', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(
      async (): Promise<AttemptOutcome> => ({ kind: 'unauthorized', detail: '401' }),
    );

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 0.5 });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.outcome.kind).toBe('unauthorized');
  });

  it('never exceeds the wall-clock budget', async () => {
    const clock = fakeClock();
    const start = clock.value;
    const attempt = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'too-early' }));

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 1 });

    expect(result.exhausted).toBe(true);
    expect(clock.value - start).toBeLessThanOrEqual(opts.budgetMs);
  });

  it('never starts a new attempt after the deadline has passed', async () => {
    // A count-based cap would silently become unbounded here: each request
    // takes 9s, so the waits alone say nothing about the elapsed total.
    const clock = fakeClock();
    const deadline = clock.value + opts.budgetMs;
    const startedAt: number[] = [];

    const attempt = vi.fn(async (): Promise<AttemptOutcome> => {
      startedAt.push(clock.now());
      clock.advance(9_000);
      return { kind: 'too-early' };
    });

    const result = await retryWithBackoff(attempt, { ...opts, ...clock, random: () => 0.5 });

    expect(startedAt.length).toBeGreaterThan(1); // it really did retry
    for (const t of startedAt) expect(t).toBeLessThan(deadline);
    expect(result.exhausted).toBe(true);
  });

  it('aborts an attempt that hangs past the budget', async () => {
    // The failure this guards: a request that never resolves would otherwise
    // hold the run open indefinitely, long past any hope of winning the slot.
    const clock = fakeClock();
    let fired: (() => void) | null = null;
    const setTimer = (fn: () => void): (() => void) => {
      fired = fn;
      return () => {
        fired = null;
      };
    };

    let sawAbort = false;
    const attempt = (signal: AbortSignal): Promise<AttemptOutcome> => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      // Never resolves — only the timeout can end this.
      queueMicrotask(() => fired?.());
      return new Promise<AttemptOutcome>(() => {});
    };

    const result = await retryWithBackoff(attempt, {
      ...opts,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
      setTimer,
    });

    expect(sawAbort).toBe(true);
    expect(result.outcome.kind).toBe('error');
    expect((result.outcome as { detail: string }).detail).toContain('aborted');
  });

  it('does not sleep past the deadline just to make one more attempt', async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const attempt = vi.fn(async (): Promise<AttemptOutcome> => ({ kind: 'too-early' }));

    await retryWithBackoff(attempt, {
      ...opts,
      budgetMs: 600,
      now: clock.now,
      sleep,
      random: () => 1,
    });

    const slept = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
    expect(slept).toBeLessThan(600);
  });

  it('reports the waits it takes so they can be logged', async () => {
    const clock = fakeClock();
    const outcomes: AttemptOutcome[] = [{ kind: 'too-early' }, { kind: 'booked' }];
    const onWait = vi.fn();

    await retryWithBackoff(async () => outcomes.shift()!, {
      ...opts,
      ...clock,
      random: () => 1,
      onWait,
    });

    expect(onWait).toHaveBeenCalledWith(1, 250);
  });

  it('honours Retry-After from a rate-limit response', async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const outcomes: AttemptOutcome[] = [
      { kind: 'rate-limited', retryAfterMs: 2_000 },
      { kind: 'booked' },
    ];

    await retryWithBackoff(async () => outcomes.shift()!, {
      ...opts,
      now: clock.now,
      sleep,
      random: () => 1,
    });

    expect(sleep).toHaveBeenCalledWith(2000);
  });
});
