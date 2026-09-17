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
 * A booking later cancelled through Elixia's own app or site — this app never
 * calls its own unbook endpoint — is dropped the same way: `reviewBookedOccurrences`
 * (lib/service.ts) is what notices and sets `cancelledAtMs`, and the entry
 * simply stops appearing here on the feed's next refresh. There is nothing to
 * mark or invalidate on the calendar side; the app the user subscribed
 * through (Google, Apple, Outlook) removes an event that is no longer in the
 * source on its own next poll, the same way it added it.
 *
 * Nothing is dropped merely for being over: a class the user turned up to is
 * a record worth keeping, and taking it off the calendar afterwards erases
 * it. But a class is only kept once Elixia has confirmed the booking still
 * held (`lastSeenBookedAtMs`), and that condition is not bureaucracy — it is
 * the whole difference between "she went" and "nobody ever looked".
 *
 * Elixia publishes its schedule from today forward, so a booking can only be
 * checked while its class is still upcoming; `matchClassBookedStatus`
 * (lib/elixia.ts) answers `unknown` for anything it cannot find, which is
 * deliberately not read as a cancellation. An unbooking nobody observed
 * before the class started therefore can never be observed at all. Treating
 * the absence of `cancelledAtMs` as attendance would turn that blind spot
 * into a permanent wrong entry: a class someone cancelled, sitting on their
 * calendar forever, with nothing left that could ever remove it. So the claim
 * rests on a check that actually happened, and an unconfirmed class leaves
 * the feed once it has started.
 *
 * The other half of making that work is that checks happen often enough to be
 * there when they are needed: `reviewBookedOccurrences` runs both inline on
 * every feed fetch and on the nightly sweep (lib/service.ts), so confirmation
 * does not depend on how often one person's calendar app happens to poll.
 *
 * How far back the feed reaches is otherwise whatever `listHistory` hands it
 * — the most recent attempts, bounded by that query's own limit — on both
 * sides, past and future alike. An attended class eventually ages out of that
 * window and leaves the calendar with it; that is the same bound the future
 * side has always had, not a second expiry rule.
 *
 * A class gets its real duration when the history row that booked it recorded
 * one (`BookingHistoryEntry.durationMin`, read from Elixia's own schedule page
 * at booking time — `ScheduleEvent.metadata.duration`, docs/api.md §4) and
 * falls back to a fixed default otherwise, for rows written before that field
 * existed.
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

/** Also used by `reviewBookedOccurrences` (lib/service.ts) to place the same occurrence in time. */
export function parseClassStart(classDate: string, startTime: string): WallClock {
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
    .filter(
      (entry) =>
        !entry.dryRun && SUCCESSFUL_OUTCOMES.has(entry.outcome) && entry.cancelledAtMs === undefined,
    )
    .map((entry) => {
      const startWall = parseClassStart(entry.classDate, entry.startTime);
      const { epochMs: startEpochMs } = zonedWallClockToInstant(startWall, profile.timeZone);
      return { entry, startWall, startEpochMs };
    })
    .filter((x) => x.startEpochMs > nowMs || x.entry.lastSeenBookedAtMs !== undefined)
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
    const endWall = addMinutes(startWall, entry.durationMin ?? DEFAULT_CLASS_DURATION_MIN);
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
      // Deliberately the same words regardless of outcome. Whether a booking
      // landed outright or on the waiting list can still change after this is
      // written — Elixia moves people up a waiting list on its own — and a
      // calendar event has no way to be revised once a client has synced it,
      // so it must not assert anything that can go stale.
      'DESCRIPTION:Booked via Elixia Booker.',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
