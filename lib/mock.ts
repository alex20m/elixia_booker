/**
 * A stand-in Elixia backend.
 *
 * Elixia's real API is still undiscovered, which would otherwise make the whole
 * application undemonstrable — you could not sign in, so you could not see the
 * UI, so nothing could be tested end to end. This backend closes that gap: with
 * MOCK_ELIXIA=1 the app is fully usable, and every layer above the adapter
 * (sign-in, encryption, subscriptions, the due index, the cron, notifications,
 * history) exercises its real code path.
 *
 * It is enabled only by explicit opt-in, and every booking it reports carries a
 * mock marker, so it cannot be mistaken for a real one.
 */

import { ElixiaCredentialsRejected, UnknownCenterError } from './types';
import type { BookingBackend } from './elixia';
import { normalizeTime, weekdayOfIsoDate } from './elixia';
import type {
  AttemptOutcome,
  CenterOption,
  ClassAvailabilityStatus,
  ClassBookedStatus,
  ClassOption,
  StoredTokens,
  Subscription,
  Weekday,
} from './types';

/** Enough centres to tell the remembered one from the rest by hand. */
const MOCK_CENTERS: CenterOption[] = [
  { id: '740', name: 'Tapiola' },
  { id: '741', name: 'Sello' },
  { id: '742', name: 'Kamppi' },
];

function slots(
  className: string,
  startTime: string,
  days: Weekday[],
  instructorName?: string,
): ClassOption[] {
  return days.map((weekday) => ({
    className,
    weekday,
    startTime,
    ...(instructorName ? { instructorName } : {}),
  }));
}

/**
 * A timetable, because a mock gym that accepts any class name would hide the
 * one thing the chooser exists to enforce: that a class has to be on the
 * schedule before it can be subscribed to.
 *
 * Every centre runs the same week — the point is to exercise the paths, not to
 * model a real club — and two names steer `book` below: anything containing
 * "full" lands on the waiting list, anything containing "busy" is refused once
 * as too-early first.
 */
const MOCK_TIMETABLE: ClassOption[] = [
  ...slots('Bodypump', '09:00', ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
  ...slots('Bodypump', '18:00', ['tuesday', 'thursday']),
  ...slots('Yoga', '17:00', ['monday', 'wednesday'], 'Maija Meikäläinen'),
  ...slots('Full House Spin', '09:00', ['tuesday', 'saturday']),
  ...slots('Busy Bootcamp', '07:00', ['monday', 'wednesday', 'friday']),
  ...slots('Cancelled Spin', '19:00', ['wednesday']),
];

/** Access tokens are short-lived so the refresh path actually gets exercised. */
const MOCK_TOKEN_TTL_MS = 10 * 60 * 1000;

export class MockElixiaClient implements BookingBackend {
  async login(email: string, password: string, nowMs: number): Promise<StoredTokens> {
    // Enough validation to exercise the failure path in the UI — and thrown as
    // the same type the real client uses, so mock mode exercises the rejection
    // branch rather than the "could not reach Elixia" one.
    if (!email.includes('@')) {
      throw new ElixiaCredentialsRejected('That does not look like an email address');
    }
    if (password.length < 4) throw new ElixiaCredentialsRejected('Incorrect email or password');

    return {
      accessToken: `mock-access-${nowMs}`,
      refreshToken: `mock-refresh-${nowMs}`,
      expiresAtMs: nowMs + MOCK_TOKEN_TTL_MS,
      updatedAtMs: nowMs,
    };
  }

  async refresh(tokens: StoredTokens, nowMs: number): Promise<StoredTokens> {
    if (!tokens.refreshToken) throw new Error('no refresh token');
    return {
      accessToken: `mock-access-${nowMs}`,
      refreshToken: `mock-refresh-${nowMs}`,
      expiresAtMs: nowMs + MOCK_TOKEN_TTL_MS,
      updatedAtMs: nowMs,
    };
  }

  async listCenters(_tokens: StoredTokens): Promise<CenterOption[]> {
    return [...MOCK_CENTERS];
  }

  /**
   * Rejects an unknown centre by name, exactly as the real client does, so the
   * error the UI shows for a stale hand-typed centre is exercised here too.
   */
  async listClasses(_tokens: StoredTokens, center: string): Promise<ClassOption[]> {
    const wanted = center.trim().toLowerCase();
    const known = MOCK_CENTERS.some((c) => c.name.toLowerCase() === wanted || c.id === wanted);
    if (!known) throw new UnknownCenterError(center);
    return [...MOCK_TIMETABLE];
  }

  async resolveClassId(
    _tokens: StoredTokens,
    subscription: Subscription,
    classDate: string,
  ): Promise<string> {
    return `mock-${subscription.className.toLowerCase().replace(/\s+/g, '-')}-${classDate}`;
  }

  /**
   * Available whenever the (name, weekday-of-date, time) triple is on the
   * mock timetable — the same triple `listClasses` publishes, just checked
   * against one concrete date instead of "any date in the window". Mirrors
   * `listClasses` in rejecting an unknown centre; unlike the real adapter
   * there is no "not published yet" state to reproduce here, since the mock
   * timetable carries no publishing horizon of its own.
   */
  async checkAvailability(
    _tokens: StoredTokens,
    center: string,
    checks: Array<{ className: string; startTime: string; classDate: string }>,
  ): Promise<ClassAvailabilityStatus[]> {
    const wanted = center.trim().toLowerCase();
    const known = MOCK_CENTERS.some((c) => c.name.toLowerCase() === wanted || c.id === wanted);
    if (!known) throw new UnknownCenterError(center);

    return checks.map((check): ClassAvailabilityStatus => {
      const weekday = weekdayOfIsoDate(check.classDate);
      if (!weekday) return 'not-published';

      const listed = MOCK_TIMETABLE.some(
        (slot) =>
          slot.className.toLowerCase() === check.className.trim().toLowerCase() &&
          slot.weekday === weekday &&
          slot.startTime === normalizeTime(check.startTime),
      );
      return listed ? 'available' : 'unavailable';
    });
  }

  /**
   * The mock has no notion of who booked what, so booked status is driven by
   * the class name the same way `book` below drives its outcome: anything
   * containing "cancel" simulates a class the user was booked into and later
   * cancelled through Elixia's own app, so the calendar-cleanup path has
   * something deterministic to exercise. Everything else on the timetable
   * reads as still booked.
   */
  async checkBookedStatus(
    _tokens: StoredTokens,
    center: string,
    checks: Array<{ className: string; startTime: string; classDate: string }>,
  ): Promise<ClassBookedStatus[]> {
    const wanted = center.trim().toLowerCase();
    const known = MOCK_CENTERS.some((c) => c.name.toLowerCase() === wanted || c.id === wanted);
    if (!known) throw new UnknownCenterError(center);

    return checks.map((check): ClassBookedStatus => {
      const weekday = weekdayOfIsoDate(check.classDate);
      if (!weekday) return 'unknown';

      const listed = MOCK_TIMETABLE.some(
        (slot) =>
          slot.className.toLowerCase() === check.className.trim().toLowerCase() &&
          slot.weekday === weekday &&
          slot.startTime === normalizeTime(check.startTime),
      );
      if (!listed) return 'unknown';

      return check.className.toLowerCase().includes('cancel') ? 'not-booked' : 'booked';
    });
  }

  /**
   * Outcome is driven by the class name so every branch is reachable by hand:
   * a class named "…full" comes back waitlisted — matching the real API, which
   * never rejects a booking for being full (docs/api.md §6) — "…busy" rejects
   * once as too-early before succeeding, and anything else books.
   */
  async book(_tokens: StoredTokens, classId: string): Promise<AttemptOutcome> {
    const id = classId.toLowerCase();

    if (id.includes('full')) {
      return { kind: 'waitlisted', position: 3, bookingId: `MOCK-${classId}` };
    }
    if (id.includes('busy') && !this.busySeen.has(classId)) {
      this.busySeen.add(classId);
      return { kind: 'too-early' };
    }
    return { kind: 'booked', bookingId: `MOCK-${classId}` };
  }

  private readonly busySeen = new Set<string>();
}

export function isMockEnabled(value: string | undefined): boolean {
  const v = (value ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
