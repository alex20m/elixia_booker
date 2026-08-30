/**
 * Turns "Bodypump, Tuesdays at 09:00" into concrete release instants.
 *
 * The nightly reindex asks: what does each account want, and when does each of
 * those open for booking? This module answers that, and it is where the weekly
 * recurrence meets the DST-aware arithmetic in schedule.ts.
 */

import { computeReleaseInstant, instantToWallClock, subtractCalendarDays } from './schedule';
import type { WallClock } from './schedule';
import { WEEKDAYS } from './types';
import type { BookingConfig, DesiredClass, PlannedBooking, Weekday } from './types';

/** Parse "HH:MM" into hour/minute, rejecting anything that is not a real time. */
export function parseStartTime(startTime: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(startTime.trim());
  if (!match) {
    throw new Error(`startTime must look like "HH:MM", got ${JSON.stringify(startTime)}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`startTime is not a valid time of day: ${JSON.stringify(startTime)}`);
  }
  return { hour, minute };
}

/** Weekday of a calendar date. Pure calendar arithmetic — no zone involved. */
export function weekdayOf(wall: Pick<WallClock, 'year' | 'month' | 'day'>): Weekday {
  const index = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const day = WEEKDAYS[index];
  if (!day) throw new Error(`unreachable: weekday index ${index}`);
  return day;
}

export function formatDate(wall: Pick<WallClock, 'year' | 'month' | 'day'>): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * How wide a net to cast when looking for the class occurrence whose booking
 * opens around now. The release for a class N days out lands N days before it,
 * so candidates cluster around `now + windowDays`; a fortnight of slack either
 * side is far more than enough to catch the one weekly occurrence.
 */
const SCAN_BACK_DAYS = 2;
const SCAN_FORWARD_DAYS = 10;

/**
 * Every release instant for one desired class that falls inside the scan
 * window, in chronological order.
 */
export function releasesFor(
  desired: DesiredClass,
  nowMs: number,
  config: Pick<BookingConfig, 'timeZone' | 'bookingWindowDays'>,
): PlannedBooking[] {
  const { hour, minute } = parseStartTime(desired.startTime);
  const windowDays = desired.bookingWindowDays ?? config.bookingWindowDays;
  const today = instantToWallClock(nowMs, config.timeZone);

  const out: PlannedBooking[] = [];

  // Walk candidate class dates around `now + windowDays`, keeping those that
  // fall on the requested weekday.
  for (let offset = windowDays - SCAN_BACK_DAYS; offset <= windowDays + SCAN_FORWARD_DAYS; offset++) {
    const date = subtractCalendarDays({ ...today, hour, minute, second: 0 }, -offset);
    if (weekdayOf(date) !== desired.weekday) continue;

    const release = computeReleaseInstant({
      classStart: date,
      bookingWindowDays: windowDays,
      timeZone: config.timeZone,
    });

    out.push({
      desired,
      releaseEpochMs: release.epochMs,
      classEpochMs: release.classEpochMs,
      classDate: formatDate(date),
      ...(release.resolution === 'exact' ? {} : { releaseNote: release.resolution }),
    });
  }

  return out.sort((a, b) => a.releaseEpochMs - b.releaseEpochMs);
}

/**
 * Every release instant for one class between two moments.
 *
 * Used by the nightly reindex to project a user's weekly classes forward. The
 * candidate class dates cluster around `now + windowDays`, so the walk covers
 * that span plus a day of slack either side rather than the whole range twice.
 */
export function releasesInRange(
  desired: DesiredClass,
  fromMs: number,
  toMs: number,
  config: Pick<BookingConfig, 'timeZone' | 'bookingWindowDays'>,
): PlannedBooking[] {
  const { hour, minute } = parseStartTime(desired.startTime);
  const windowDays = desired.bookingWindowDays ?? config.bookingWindowDays;
  const start = instantToWallClock(fromMs, config.timeZone);

  const spanDays = Math.ceil((toMs - fromMs) / 86_400_000);
  const out: PlannedBooking[] = [];

  for (let offset = windowDays - 1; offset <= windowDays + spanDays + 1; offset++) {
    const date = subtractCalendarDays({ ...start, hour, minute, second: 0 }, -offset);
    if (weekdayOf(date) !== desired.weekday) continue;

    const release = computeReleaseInstant({
      classStart: date,
      bookingWindowDays: windowDays,
      timeZone: config.timeZone,
    });

    if (release.epochMs < fromMs || release.epochMs > toMs) continue;

    out.push({
      desired,
      releaseEpochMs: release.epochMs,
      classEpochMs: release.classEpochMs,
      classDate: formatDate(date),
      ...(release.resolution === 'exact' ? {} : { releaseNote: release.resolution }),
    });
  }

  return out.sort((a, b) => a.releaseEpochMs - b.releaseEpochMs);
}

/**
 * The bookings whose release instant this run should act on.
 *
 * Claims anything releasing between `now - claimGraceMs` and
 * `now + claimHorizonMs`. The grace window matters because Cloudflare's cron
 * firing is approximate: without it, a run that starts a few seconds late would
 * skip the slot rather than fire immediately, which is strictly worse.
 *
 * Sorted by priority first so that when two classes open in the same run, the
 * one you care about most gets the earliest attempt.
 */
export function planDueBookings(config: BookingConfig, nowMs: number): PlannedBooking[] {
  const due: PlannedBooking[] = [];

  for (const desired of config.classes) {
    if (desired.enabled === false) continue;

    for (const planned of releasesFor(desired, nowMs, config)) {
      const delta = planned.releaseEpochMs - nowMs;
      if (delta <= config.claimHorizonMs && delta >= -config.claimGraceMs) {
        due.push(planned);
      }
    }
  }

  return due.sort(
    (a, b) =>
      a.desired.priority - b.desired.priority || a.releaseEpochMs - b.releaseEpochMs,
  );
}
