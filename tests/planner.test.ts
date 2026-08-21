import { describe, expect, it } from 'vitest';
import { formatDate, parseStartTime, planDueBookings, releasesFor, weekdayOf } from '../lib/planner';
import type { BookingConfig, DesiredClass } from '../lib/types';

const utc = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad fixture timestamp: ${iso}`);
  return ms;
};

const baseConfig: BookingConfig = {
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

const bodypump: DesiredClass = {
  id: 'bodypump-tue-0900',
  center: 'tapiola',
  className: 'Bodypump',
  weekday: 'tuesday',
  startTime: '09:00',
  priority: 1,
};

describe('parseStartTime', () => {
  it('parses a normal time', () => {
    expect(parseStartTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseStartTime('17:30')).toEqual({ hour: 17, minute: 30 });
  });

  it('accepts a single-digit hour', () => {
    expect(parseStartTime('7:05')).toEqual({ hour: 7, minute: 5 });
  });

  it('rejects times that are not real', () => {
    expect(() => parseStartTime('24:00')).toThrow();
    expect(() => parseStartTime('09:60')).toThrow();
    expect(() => parseStartTime('9')).toThrow();
    expect(() => parseStartTime('nine')).toThrow();
    expect(() => parseStartTime('')).toThrow();
  });
});

describe('weekdayOf', () => {
  it('names the weekday of a calendar date', () => {
    // 2026-08-13 is a Thursday.
    expect(weekdayOf({ year: 2026, month: 8, day: 13 })).toBe('thursday');
    expect(weekdayOf({ year: 2026, month: 3, day: 31 })).toBe('tuesday');
    expect(weekdayOf({ year: 2026, month: 3, day: 29 })).toBe('sunday');
  });
});

describe('formatDate', () => {
  it('zero-pads month and day', () => {
    expect(formatDate({ year: 2026, month: 3, day: 7 })).toBe('2026-03-07');
  });
});

describe('releasesFor', () => {
  it('finds the Tuesday class whose booking opens around now', () => {
    // Now: Tue 2026-08-11 08:55 Helsinki (+3) = 05:55Z.
    // The 7-day window means the class releasing now is Tue 2026-08-18 09:00.
    const releases = releasesFor(bodypump, utc('2026-08-11T05:55:00Z'), baseConfig);

    const match = releases.find((r) => r.classDate === '2026-08-18');
    expect(match).toBeDefined();
    expect(match!.releaseEpochMs).toBe(utc('2026-08-11T06:00:00Z'));
    expect(match!.classEpochMs).toBe(utc('2026-08-18T06:00:00Z'));
  });

  it('only returns occurrences on the requested weekday', () => {
    const releases = releasesFor(bodypump, utc('2026-08-11T05:55:00Z'), baseConfig);
    expect(releases.length).toBeGreaterThan(0);
    for (const r of releases) {
      const [y, m, d] = r.classDate.split('-').map(Number);
      expect(weekdayOf({ year: y!, month: m!, day: d! })).toBe('tuesday');
    }
  });

  it('returns releases in chronological order', () => {
    const releases = releasesFor(bodypump, utc('2026-08-11T05:55:00Z'), baseConfig);
    const times = releases.map((r) => r.releaseEpochMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('honours a per-class 14-day Premium window', () => {
    const premium: DesiredClass = { ...bodypump, bookingWindowDays: 14 };
    // Class Tue 2026-08-25 09:00 opens 14 days earlier, Tue 2026-08-11 09:00.
    const releases = releasesFor(premium, utc('2026-08-11T05:55:00Z'), baseConfig);

    const match = releases.find((r) => r.classDate === '2026-08-25');
    expect(match).toBeDefined();
    expect(match!.releaseEpochMs).toBe(utc('2026-08-11T06:00:00Z'));
  });

  it('flags a release that lands on a DST edge', () => {
    // 03:30 on Sun 2026-03-29 does not exist; a Sunday 03:30 class 7 days later
    // would release into the gap.
    const odd: DesiredClass = { ...bodypump, weekday: 'sunday', startTime: '03:30' };
    const releases = releasesFor(odd, utc('2026-03-29T00:00:00Z'), baseConfig);

    const match = releases.find((r) => r.classDate === '2026-04-05');
    expect(match).toBeDefined();
    expect(match!.releaseNote).toBe('gap');
  });
});

describe('planDueBookings', () => {
  const withClasses = (classes: DesiredClass[]): BookingConfig => ({ ...baseConfig, classes });

  it('claims a release falling inside the horizon', () => {
    // Release at 06:00Z; now is 30s before.
    const due = planDueBookings(withClasses([bodypump]), utc('2026-08-11T05:59:30Z'));
    expect(due).toHaveLength(1);
    expect(due[0]!.releaseEpochMs).toBe(utc('2026-08-11T06:00:00Z'));
  });

  it('ignores a release far beyond the horizon', () => {
    // Now is ~6 days before the release — well outside the 90s horizon.
    const due = planDueBookings(withClasses([bodypump]), utc('2026-08-05T06:00:00Z'));
    expect(due).toHaveLength(0);
  });

  it('still claims a release the run arrived late for', () => {
    // Cron fired 60s late. Grace is 120s, so this must still be attempted —
    // firing immediately beats skipping the slot.
    const due = planDueBookings(withClasses([bodypump]), utc('2026-08-11T06:01:00Z'));
    expect(due).toHaveLength(1);
  });

  it('gives up once a release is older than the grace window', () => {
    // 3 minutes late, grace is 2 minutes.
    const due = planDueBookings(withClasses([bodypump]), utc('2026-08-11T06:03:00Z'));
    expect(due).toHaveLength(0);
  });

  it('skips disabled classes', () => {
    const due = planDueBookings(
      withClasses([{ ...bodypump, enabled: false }]),
      utc('2026-08-11T05:59:30Z'),
    );
    expect(due).toHaveLength(0);
  });

  it('orders same-instant releases by priority, lowest number first', () => {
    const second: DesiredClass = { ...bodypump, id: 'yoga', className: 'Yoga', priority: 5 };
    const third: DesiredClass = { ...bodypump, id: 'spin', className: 'Spin', priority: 3 };
    const due = planDueBookings(
      withClasses([second, third, bodypump]),
      utc('2026-08-11T05:59:30Z'),
    );

    expect(due.map((d) => d.desired.className)).toEqual(['Bodypump', 'Spin', 'Yoga']);
  });

  it('claims the right occurrence when the window crosses a DST transition', () => {
    // Class Tue 2026-03-31 09:00 EEST opens Tue 2026-03-24 09:00 EET = 07:00Z.
    // A naive implementation would look for 06:00Z and find nothing.
    const due = planDueBookings(withClasses([bodypump]), utc('2026-03-24T06:59:30Z'));
    expect(due).toHaveLength(1);
    expect(due[0]!.classDate).toBe('2026-03-31');
    expect(due[0]!.releaseEpochMs).toBe(utc('2026-03-24T07:00:00Z'));
  });
});
