import { describe, expect, it } from 'vitest';
import {
  computeReleaseInstant,
  instantToWallClock,
  offsetMsAt,
  subtractCalendarDays,
  zonedWallClockToInstant,
  type WallClock,
} from '../lib/schedule';

const HELSINKI = 'Europe/Helsinki';
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Expected instants are written as literal UTC timestamps, each verified
 * against the IANA database rather than derived from the code under test.
 *
 * Europe/Helsinki in 2026:
 *   - spring forward  Sun 29 Mar, 03:00 EET (+2) -> 04:00 EEST (+3)
 *   - fall back       Sun 25 Oct, 04:00 EEST (+3) -> 03:00 EET (+2)
 */
const utc = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad fixture timestamp: ${iso}`);
  return ms;
};

describe('computeReleaseInstant', () => {
  it('opens booking at the same local time, one week earlier, when no DST change intervenes', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 2, day: 11, hour: 18, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-02-04T16:00:00Z'));
    expect(result.classEpochMs).toBe(utc('2026-02-11T16:00:00Z'));
    expect(result.resolution).toBe('exact');
    expect(result.crossesDstTransition).toBe(false);
  });

  it('keeps the release at 09:00 local when the clocks go forward inside the window', () => {
    // Class 31 Mar 09:00 EEST (+3); release 24 Mar 09:00 EET (+2).
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 3, day: 31, hour: 9, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-03-24T07:00:00Z'));
    expect(result.classEpochMs).toBe(utc('2026-03-31T06:00:00Z'));
    expect(result.crossesDstTransition).toBe(true);
  });

  it('keeps the release at 09:00 local when the clocks go back inside the window', () => {
    // Class 28 Oct 09:00 EET (+2); release 21 Oct 09:00 EEST (+3).
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 10, day: 28, hour: 9, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-10-21T06:00:00Z'));
    expect(result.classEpochMs).toBe(utc('2026-10-28T07:00:00Z'));
    expect(result.crossesDstTransition).toBe(true);
  });

  it('does not simply subtract 7*24h when a DST transition falls in the window', () => {
    // The bug this whole module exists to prevent. Subtracting elapsed time
    // rather than calendar days lands an hour late in autumn — by which point
    // a popular class is already full.
    const autumn = computeReleaseInstant({
      classStart: { year: 2026, month: 10, day: 28, hour: 9, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });
    expect(autumn.epochMs).not.toBe(autumn.classEpochMs - 7 * DAY);
    expect(autumn.classEpochMs - autumn.epochMs).toBe(7 * DAY + HOUR);

    // …and an hour early in spring, which wastes the run.
    const spring = computeReleaseInstant({
      classStart: { year: 2026, month: 3, day: 31, hour: 9, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });
    expect(spring.epochMs).not.toBe(spring.classEpochMs - 7 * DAY);
    expect(spring.classEpochMs - spring.epochMs).toBe(7 * DAY - HOUR);
  });

  it('handles the 14-day Premium window across a DST transition', () => {
    // Class 8 Apr 18:00 EEST (+3); release 25 Mar 18:00 EET (+2).
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 4, day: 8, hour: 18, minute: 0 },
      bookingWindowDays: 14,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-03-25T16:00:00Z'));
    expect(result.classEpochMs).toBe(utc('2026-04-08T15:00:00Z'));
    expect(result.crossesDstTransition).toBe(true);
  });

  it('shifts a release that lands in the spring-forward gap to the first real instant', () => {
    // 29 Mar 03:30 local never happens — clocks jump 03:00 -> 04:00.
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 4, day: 5, hour: 3, minute: 30 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.resolution).toBe('gap');
    expect(result.epochMs).toBe(utc('2026-03-29T01:30:00Z')); // 04:30 EEST
  });

  it('picks the earlier instant when a release lands in the fall-back overlap', () => {
    // 25 Oct 03:30 local happens twice: 00:30Z (+3) and 01:30Z (+2).
    // Being an hour early is recoverable; being an hour late is not.
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 11, day: 1, hour: 3, minute: 30 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.resolution).toBe('ambiguous');
    expect(result.epochMs).toBe(utc('2026-10-25T00:30:00Z'));
  });

  it('handles a midnight class whose window crosses the spring transition', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 3, day: 30, hour: 0, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-03-22T22:00:00Z')); // 23 Mar 00:00 EET
    expect(result.classEpochMs).toBe(utc('2026-03-29T21:00:00Z')); // 30 Mar 00:00 EEST
    expect(result.wallClock).toEqual({
      year: 2026,
      month: 3,
      day: 23,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it('walks back across a year boundary', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2027, month: 1, day: 3, hour: 10, minute: 0 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-12-27T08:00:00Z'));
    expect(result.wallClock.year).toBe(2026);
    expect(result.wallClock.month).toBe(12);
    expect(result.wallClock.day).toBe(27);
  });

  it('treats a zero-day window as opening at the class start itself', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 6, day: 1, hour: 12, minute: 0 },
      bookingWindowDays: 0,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(result.classEpochMs);
    expect(result.epochMs).toBe(utc('2026-06-01T09:00:00Z'));
  });

  it('defaults to Europe/Helsinki when no zone is given', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 7, day: 15, hour: 17, minute: 30 },
      bookingWindowDays: 7,
    });

    expect(result.epochMs).toBe(utc('2026-07-08T14:30:00Z')); // 17:30 EEST (+3)
  });

  it('rejects a booking window that is not a whole number of days', () => {
    expect(() =>
      computeReleaseInstant({
        classStart: { year: 2026, month: 6, day: 1, hour: 12, minute: 0 },
        bookingWindowDays: 7.5,
      }),
    ).toThrow(RangeError);

    expect(() =>
      computeReleaseInstant({
        classStart: { year: 2026, month: 6, day: 1, hour: 12, minute: 0 },
        bookingWindowDays: -7,
      }),
    ).toThrow(RangeError);
  });

  it('preserves seconds precision in the release instant', () => {
    const result = computeReleaseInstant({
      classStart: { year: 2026, month: 6, day: 10, hour: 8, minute: 15, second: 30 },
      bookingWindowDays: 7,
      timeZone: HELSINKI,
    });

    expect(result.epochMs).toBe(utc('2026-06-03T05:15:30Z'));
  });
});

describe('zonedWallClockToInstant', () => {
  it('resolves a summer wall clock at UTC+3', () => {
    const wall: WallClock = { year: 2026, month: 7, day: 1, hour: 12, minute: 0 };
    expect(zonedWallClockToInstant(wall, HELSINKI)).toEqual({
      epochMs: utc('2026-07-01T09:00:00Z'),
      resolution: 'exact',
    });
  });

  it('resolves a winter wall clock at UTC+2', () => {
    const wall: WallClock = { year: 2026, month: 1, day: 15, hour: 12, minute: 0 };
    expect(zonedWallClockToInstant(wall, HELSINKI)).toEqual({
      epochMs: utc('2026-01-15T10:00:00Z'),
      resolution: 'exact',
    });
  });

  it('resolves the instant the clocks spring forward', () => {
    // 04:00 EEST is the first wall-clock time after the jump.
    const wall: WallClock = { year: 2026, month: 3, day: 29, hour: 4, minute: 0 };
    expect(zonedWallClockToInstant(wall, HELSINKI)).toEqual({
      epochMs: utc('2026-03-29T01:00:00Z'),
      resolution: 'exact',
    });
  });

  it('reports the whole skipped hour as a gap', () => {
    for (const minute of [0, 1, 30, 59]) {
      const wall: WallClock = { year: 2026, month: 3, day: 29, hour: 3, minute };
      expect(zonedWallClockToInstant(wall, HELSINKI).resolution).toBe('gap');
    }
  });

  it('reports the whole repeated hour as ambiguous', () => {
    for (const minute of [0, 1, 30, 59]) {
      const wall: WallClock = { year: 2026, month: 10, day: 25, hour: 3, minute };
      expect(zonedWallClockToInstant(wall, HELSINKI).resolution).toBe('ambiguous');
    }
  });

  it('round-trips wall clock -> instant -> wall clock outside DST edges', () => {
    const wall: WallClock = { year: 2026, month: 9, day: 3, hour: 19, minute: 45, second: 12 };
    const { epochMs } = zonedWallClockToInstant(wall, HELSINKI);
    expect(instantToWallClock(epochMs, HELSINKI)).toEqual(wall);
  });

  it('handles a zone with a half-hour offset', () => {
    // Guards against an implementation that assumes whole-hour offsets.
    const wall: WallClock = { year: 2026, month: 6, day: 1, hour: 12, minute: 0 };
    expect(zonedWallClockToInstant(wall, 'Asia/Kolkata').epochMs).toBe(
      utc('2026-06-01T06:30:00Z'),
    );
  });

  it('resolves UTC itself as an identity mapping', () => {
    const wall: WallClock = { year: 2026, month: 6, day: 1, hour: 12, minute: 0 };
    expect(zonedWallClockToInstant(wall, 'UTC').epochMs).toBe(utc('2026-06-01T12:00:00Z'));
  });
});

describe('offsetMsAt', () => {
  it('reports +2h in Helsinki winter and +3h in summer', () => {
    expect(offsetMsAt(utc('2026-01-15T12:00:00Z'), HELSINKI)).toBe(2 * HOUR);
    expect(offsetMsAt(utc('2026-07-15T12:00:00Z'), HELSINKI)).toBe(3 * HOUR);
  });

  it('flips exactly at the transition instant', () => {
    expect(offsetMsAt(utc('2026-03-29T00:59:59Z'), HELSINKI)).toBe(2 * HOUR);
    expect(offsetMsAt(utc('2026-03-29T01:00:00Z'), HELSINKI)).toBe(3 * HOUR);
  });
});

describe('subtractCalendarDays', () => {
  it('walks back across a month boundary', () => {
    expect(subtractCalendarDays({ year: 2026, month: 3, day: 5, hour: 9, minute: 30 }, 7)).toEqual({
      year: 2026,
      month: 2,
      day: 26,
      hour: 9,
      minute: 30,
      second: 0,
    });
  });

  it('walks back across a leap day', () => {
    expect(subtractCalendarDays({ year: 2028, month: 3, day: 3, hour: 7, minute: 0 }, 7)).toEqual({
      year: 2028,
      month: 2,
      day: 25, // 2028 is a leap year: 29 Feb exists
      hour: 7,
      minute: 0,
      second: 0,
    });
  });

  it('leaves the time of day untouched', () => {
    const result = subtractCalendarDays(
      { year: 2026, month: 5, day: 20, hour: 23, minute: 59, second: 58 },
      14,
    );
    expect(result.hour).toBe(23);
    expect(result.minute).toBe(59);
    expect(result.second).toBe(58);
  });
});
