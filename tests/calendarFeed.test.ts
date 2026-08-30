import { describe, expect, it } from 'vitest';
import { buildCalendarFeed, newCalendarFeedToken, CALENDAR_TOKEN_PATTERN } from '@/lib/calendarFeed';
import type { BookingHistoryEntry, ConfiguredProfile } from '@/lib/types';

/**
 * The ICS document the feed serves.
 *
 * What matters here is not RFC 5545 conformance in general — Google, Apple and
 * Outlook are all forgiving — but the handful of decisions specific to this
 * feed: which history entries earn a place on the calendar, and which do not.
 */

const NOW = Date.UTC(2026, 8, 1, 12, 0); // 2026-09-01 12:00 UTC

const profile: ConfiguredProfile = {
  id: 'alice',
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'none',
  configuredAtMs: NOW,
  elixiaStatus: 'ok',
};

const entry = (overrides: Partial<BookingHistoryEntry> = {}): BookingHistoryEntry => ({
  atMs: NOW,
  subscriptionId: 'sub-1',
  className: 'Bodypump',
  classDate: '2026-09-08',
  startTime: '09:00',
  outcome: 'booked',
  attempts: 1,
  firstAttemptOffsetMs: 120,
  dryRun: false,
  center: 'Tapiola',
  ...overrides,
});

describe('newCalendarFeedToken', () => {
  it('mints a token this feed will actually accept', () => {
    expect(CALENDAR_TOKEN_PATTERN.test(newCalendarFeedToken())).toBe(true);
  });

  it('never repeats itself', () => {
    expect(newCalendarFeedToken()).not.toBe(newCalendarFeedToken());
  });
});

describe('buildCalendarFeed', () => {
  it('lists a booked class as a VEVENT with its name, place and local time', () => {
    const ics = buildCalendarFeed(profile, [entry()], NOW);

    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Bodypump');
    expect(ics).toContain('LOCATION:Tapiola');
    // 09:00 in Europe/Helsinki on that date is UTC+3 (EEST), expressed with
    // the zone's own TZID rather than converted to UTC.
    expect(ics).toContain('DTSTART;TZID=Europe/Helsinki:20260908T090000');
    expect(ics).toContain('DTEND;TZID=Europe/Helsinki:20260908T100000');
  });

  it('includes a waitlisted class too, with the same description as a booked one', () => {
    // Deliberately not distinguished: a waitlist position can change after
    // this is written (Elixia moves people up on its own), and a synced
    // calendar event has no way to be revised once a client has it — so the
    // description must never assert something that can go stale.
    const ics = buildCalendarFeed(profile, [entry({ outcome: 'waitlisted' })], NOW);

    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DESCRIPTION:Booked via Elixia Booker.');
  });

  it('leaves out attempts that never won a place', () => {
    const ics = buildCalendarFeed(
      profile,
      [entry({ outcome: 'too-early' }), entry({ outcome: 'error' }), entry({ outcome: 'unauthorized' })],
      NOW,
    );

    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('leaves out dry runs, so a test deployment cannot leak fake bookings onto a real calendar', () => {
    const ics = buildCalendarFeed(profile, [entry({ dryRun: true })], NOW);

    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('drops a booking found cancelled through Elixia, so it disappears on the next sync', () => {
    const ics = buildCalendarFeed(profile, [entry({ cancelledAtMs: NOW })], NOW);

    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('drops a class that finished more than a day ago', () => {
    const longGone = entry({ classDate: '2026-08-01', startTime: '09:00' });

    const ics = buildCalendarFeed(profile, [longGone], NOW);

    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('keeps a class from earlier today', () => {
    const today = entry({ classDate: '2026-09-01', startTime: '08:00' });

    const ics = buildCalendarFeed(profile, [today], NOW);

    expect(ics).toContain('BEGIN:VEVENT');
  });

  it('gives the same occurrence the same UID across refetches', () => {
    const first = buildCalendarFeed(profile, [entry()], NOW);
    const second = buildCalendarFeed(profile, [entry()], NOW + 60_000);

    const uid = (ics: string): string => /UID:(\S+)/.exec(ics)![1]!;
    expect(uid(first)).toBe(uid(second));
  });

  it('escapes text that would otherwise corrupt the document', () => {
    const ics = buildCalendarFeed(profile, [entry({ className: 'Yoga; Flow, relax\nnow' })], NOW);

    expect(ics).toContain('SUMMARY:Yoga\\; Flow\\, relax\\nnow');
  });

  it('orders events by when the class actually happens', () => {
    const later = entry({ classDate: '2026-09-15', startTime: '09:00', className: 'Later' });
    const sooner = entry({ classDate: '2026-09-08', startTime: '09:00', className: 'Sooner' });

    const ics = buildCalendarFeed(profile, [later, sooner], NOW);

    expect(ics.indexOf('SUMMARY:Sooner')).toBeLessThan(ics.indexOf('SUMMARY:Later'));
  });
});
