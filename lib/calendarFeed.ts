/**
 * The subscribable calendar feed: an ICS document listing classes a user has
 * actually been booked or waitlisted into.
 *
 * Only outcomes `executeBooking` counts as success (see `isSuccess` in
 * lib/booking.ts) go in. A future occurrence that has not been attempted yet
 * is not a reservation — Elixia has not been asked for it — so listing it
 * would put something on a calendar that might never be won. This mirrors
 * what booking through the SATS/Elixia app itself does: a class lands on your
 * calendar once it is actually booked, not the moment you decide you want it.
 *
 * Every class gets a fixed duration, because neither `Subscription` nor
 * `BookingHistoryEntry` records how long one runs — Elixia's schedule page
 * exposes it (`ScheduleEvent.metadata.duration`, docs/api.md §4) but nothing
 * persists it today. Getting an end time approximately right is enough for a
 * calendar entry; wiring the real duration through is a job of its own if it
 * turns out to matter.
 */

import { randomBytes } from 'node:crypto';
import { zonedWallClockToInstant, type WallClock } from './schedule';
import type { BookingHistoryEntry, ConfiguredProfile } from './types';

/** Shape of a token this module minted. Anything else cannot be a real feed. */
export const CALENDAR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 32 bytes of randomness, hex-encoded — unguessable, and never reused. */
export function newCalendarFeedToken(): string {
  return randomBytes(32).toString('hex');
}

/** Assumed length of every class, in the absence of a real one. */
const DEFAULT_CLASS_DURATION_MIN = 60;

/**
 * How far into the past a class may have started and still appear.
 *
 * Long enough that a class earlier today does not vanish from the feed while
 * it is still running or just after; short enough that the feed does not
 * accumulate months of finished classes nobody is looking at. There is no
 * upper bound on the future side — `listHistory`'s own limit already caps how
 * far ahead this can reach.
 */
const PAST_GRACE_MS = 24 * 60 * 60 * 1000;

function parseClassStart(classDate: string, startTime: string): WallClock {
  const [year, month, day] = classDate.split('-').map(Number) as [number, number, number];
  const [hour, minute] = startTime.split(':').map(Number) as [number, number];
  return { year, month, day, hour, minute };
}

function addMinutes(wall: WallClock, minutes: number): WallClock {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
  const shifted = new Date(asUtc + minutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A wall-clock time as ICS wants it when paired with a `TZID` parameter. */
function formatIcsLocal(wall: WallClock): string {
  return `${wall.year}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}00`;
}

/** An instant as ICS wants it in UTC — the trailing `Z` is what marks it so. */
function formatIcsUtc(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escape the handful of characters RFC 5545 reserves in free text values. */
function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

const SUCCESSFUL_OUTCOMES = new Set<BookingHistoryEntry['outcome']>(['booked', 'waitlisted']);

/**
 * Build the ICS document for one user's feed.
 *
 * `history` is expected to be whatever `listHistory` returns — most-recent
 * attempts first, already bounded — not a purpose-built query, so this feed
 * costs nothing beyond what the dashboard already pays for the same data.
 */
export function buildCalendarFeed(
  profile: ConfiguredProfile,
  history: readonly BookingHistoryEntry[],
  nowMs: number,
): string {
  const events = history
    .filter((entry) => !entry.dryRun && SUCCESSFUL_OUTCOMES.has(entry.outcome))
    .map((entry) => {
      const startWall = parseClassStart(entry.classDate, entry.startTime);
      const { epochMs: startEpochMs } = zonedWallClockToInstant(startWall, profile.timeZone);
      return { entry, startWall, startEpochMs };
    })
    .filter((x) => x.startEpochMs >= nowMs - PAST_GRACE_MS)
    .sort((a, b) => a.startEpochMs - b.startEpochMs);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Elixia Booker//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Elixia classes',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const { entry, startWall } of events) {
    const endWall = addMinutes(startWall, DEFAULT_CLASS_DURATION_MIN);
    // Stable across refetches of the same occurrence, so a calendar app can
    // tell "still the same class" from "a new one" rather than duplicating
    // every event on every poll. Falls back to a class/date/time key when the
    // subscription behind it has since been deleted.
    const uid = `${entry.subscriptionId ?? 'unlinked'}-${entry.classDate}-${entry.startTime.replace(':', '')}@elixia-booker`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatIcsUtc(nowMs)}`,
      `DTSTART;TZID=${profile.timeZone}:${formatIcsLocal(startWall)}`,
      `DTEND;TZID=${profile.timeZone}:${formatIcsLocal(endWall)}`,
      `SUMMARY:${escapeIcsText(entry.className)}`,
    );
    if (entry.center) lines.push(`LOCATION:${escapeIcsText(entry.center)}`);
    lines.push(
      `DESCRIPTION:${escapeIcsText(
        entry.outcome === 'waitlisted'
          ? 'Booked via Elixia Booker — you are on the waiting list.'
          : 'Booked via Elixia Booker.',
      )}`,
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
