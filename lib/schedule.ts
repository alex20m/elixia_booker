/**
 * Booking-window arithmetic.
 *
 * Elixia opens booking a fixed number of days before a class starts — 7 days on
 * Basic/Flexible, 14 on Premium. The bot has to know the release instant to the
 * millisecond, in UTC, because that is the only clock a Worker has.
 *
 * The whole problem is that "7 days before" is a statement about the *wall
 * clock in Europe/Helsinki*, not about elapsed time. A class at 09:00 on 31
 * March opens at 09:00 on 24 March — but Finland changed from UTC+2 to UTC+3 in
 * between, so those two instants are 7 days minus one hour apart. Subtracting
 * `7 * 24 * 60 * 60 * 1000` from the class instant lands an hour off, twice a
 * year. An hour early is a wasted run; an hour late means the class is gone.
 *
 * Everything here uses `Intl.DateTimeFormat` for zone data, so it runs on
 * Cloudflare Workers with no dependencies and no bundled tz database.
 */

/** A calendar date + time of day, with no zone attached. */
export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second?: number;
}

/**
 * How a wall-clock time mapped onto the timeline.
 *
 * - `exact`     — the normal case: exactly one instant matches.
 * - `gap`       — the local time does not exist (spring forward skipped it).
 *                 Resolved by shifting forward by the size of the gap.
 * - `ambiguous` — the local time happens twice (autumn fall-back). Resolved to
 *                 the *earlier* instant, so the bot is ready before booking
 *                 opens rather than an hour after it did.
 */
export type Resolution = 'exact' | 'gap' | 'ambiguous';

export interface ZonedInstant {
  epochMs: number;
  resolution: Resolution;
}

export interface ReleaseInstant {
  /** When booking opens, as epoch milliseconds UTC. */
  epochMs: number;
  /** The wall-clock time booking opens, in the class's zone. */
  wallClock: WallClock;
  /** How the release wall-clock time mapped onto the timeline. */
  resolution: Resolution;
  /** The class start instant, epoch milliseconds UTC. */
  classEpochMs: number;
  /**
   * True when the zone's UTC offset differs between the release instant and the
   * class start — i.e. a DST transition falls inside the booking window, and
   * naive epoch subtraction would have been wrong.
   */
  crossesDstTransition: boolean;
}

const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Read the wall clock a given instant shows in a given zone. */
export function instantToWallClock(epochMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`missing ${type} in formatted date for zone ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The zone's UTC offset, in milliseconds, at a given instant.
 * Positive east of Greenwich (Europe/Helsinki is +2h or +3h).
 */
export function offsetMsAt(epochMs: number, timeZone: string): number {
  const w = instantToWallClock(epochMs, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
  // Formatting drops sub-second precision; add it back so the offset is exact.
  return asIfUtc - (epochMs - mod(epochMs, 1000));
}

/** Floored modulo, so negative epochs (pre-1970) behave. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function wallToNaiveUtc(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
}

/**
 * Resolve a wall-clock time in a zone to an instant.
 *
 * Probes the offset a day either side of the target, which brackets any single
 * DST transition, and keeps whichever candidates are self-consistent. Zero, one
 * or two survive — that is exactly the gap / exact / ambiguous trichotomy.
 */
export function zonedWallClockToInstant(wall: WallClock, timeZone: string): ZonedInstant {
  const naive = wallToNaiveUtc(wall);

  const offsetBefore = offsetMsAt(naive - MS_PER_DAY, timeZone);
  const offsetAfter = offsetMsAt(naive + MS_PER_DAY, timeZone);

  const candidateBefore = naive - offsetBefore;
  const candidateAfter = naive - offsetAfter;

  // A candidate is real only if the zone actually has that offset at that instant.
  const beforeValid = offsetMsAt(candidateBefore, timeZone) === offsetBefore;
  const afterValid = offsetMsAt(candidateAfter, timeZone) === offsetAfter;

  if (beforeValid && afterValid) {
    if (candidateBefore === candidateAfter) {
      return { epochMs: candidateBefore, resolution: 'exact' };
    }
    // Fall-back overlap: take the first occurrence.
    return { epochMs: Math.min(candidateBefore, candidateAfter), resolution: 'ambiguous' };
  }

  if (beforeValid) return { epochMs: candidateBefore, resolution: 'exact' };
  if (afterValid) return { epochMs: candidateAfter, resolution: 'exact' };

  // Spring-forward gap: the wall time was skipped. Shift forward by the gap.
  return { epochMs: Math.max(candidateBefore, candidateAfter), resolution: 'gap' };
}

/**
 * Shift a wall-clock time back by whole calendar days, keeping the time of day.
 * Pure calendar arithmetic — no zone involved, so DST cannot corrupt it.
 */
export function subtractCalendarDays(wall: WallClock, days: number): WallClock {
  const midnight = Date.UTC(wall.year, wall.month - 1, wall.day);
  const shifted = new Date(midnight - days * MS_PER_DAY);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second ?? 0,
  };
}

export interface ReleaseOptions {
  /** Class start, as it appears on the schedule, in `timeZone`. */
  classStart: WallClock;
  /** Days before the class that booking opens. 7 for Basic/Flexible, 14 for Premium. */
  bookingWindowDays: number;
  /** IANA zone the schedule is published in. Defaults to Europe/Helsinki. */
  timeZone?: string;
}

/**
 * Compute the instant booking opens for a class.
 *
 * The release is the same time of day as the class, `bookingWindowDays`
 * calendar days earlier, interpreted in the club's local zone.
 */
export function computeReleaseInstant(options: ReleaseOptions): ReleaseInstant {
  const { classStart, bookingWindowDays, timeZone = 'Europe/Helsinki' } = options;

  if (!Number.isInteger(bookingWindowDays) || bookingWindowDays < 0) {
    throw new RangeError(
      `bookingWindowDays must be a non-negative integer, got ${bookingWindowDays}`,
    );
  }

  const classInstant = zonedWallClockToInstant(classStart, timeZone);
  const releaseWall = subtractCalendarDays(classStart, bookingWindowDays);
  const release = zonedWallClockToInstant(releaseWall, timeZone);

  return {
    epochMs: release.epochMs,
    wallClock: releaseWall,
    resolution: release.resolution,
    classEpochMs: classInstant.epochMs,
    crossesDstTransition:
      offsetMsAt(release.epochMs, timeZone) !== offsetMsAt(classInstant.epochMs, timeZone),
  };
}
