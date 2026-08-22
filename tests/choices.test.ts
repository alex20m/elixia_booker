import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_OPTIONS, isMembershipWindow } from '@/lib/membership';
import { TIME_ZONE_GROUPS, TIME_ZONE_IDS, isOfferedTimeZone } from '@/lib/timezones';

/**
 * The two lists a user picks from during setup, and the guards that make those
 * lists the *only* accepted answers.
 *
 * This is what "no manual typing" means once the form is out of the picture: a
 * request carrying a timezone nobody was offered is refused, so a broken client
 * or a hand-rolled curl cannot store a zone the app can never render a schedule
 * in. The lists are checked against `Intl` itself rather than against a copy of
 * themselves, because a typo in an IANA id is invisible until the day it has to
 * turn a class time into an instant.
 */

describe('the timezones on offer', () => {
  it('offers only zones the platform can actually resolve', () => {
    for (const id of TIME_ZONE_IDS) {
      expect(
        () => new Intl.DateTimeFormat('en-US', { timeZone: id }),
        `${id} is not a zone Intl accepts`,
      ).not.toThrow();
    }
  });

  it('names every zone once, so a picker cannot show a duplicate', () => {
    expect(TIME_ZONE_IDS).toEqual([...new Set(TIME_ZONE_IDS)]);
  });

  it('covers the countries Elixia operates in', () => {
    // A member in Espoo who cannot find Helsinki has no way to finish setup at
    // all — there is no free-text box to fall back to any more.
    for (const zone of ['Europe/Helsinki', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Tallinn']) {
      expect(TIME_ZONE_IDS).toContain(zone);
    }
  });

  it('gives every zone a label that is not just the id repeated', () => {
    // The id is the machine's name for it; the list exists so a person can find
    // their own city without knowing that "Europe/Kyiv" was once "Europe/Kiev".
    for (const group of TIME_ZONE_GROUPS) {
      expect(group.zones.length).toBeGreaterThan(0);
      for (const zone of group.zones) {
        expect(zone.label.length).toBeGreaterThan(0);
        expect(zone.label).not.toBe(zone.id);
      }
    }
  });

  it('accepts a zone from the list and refuses one that was never offered', () => {
    expect(isOfferedTimeZone('Europe/Helsinki')).toBe(true);
    // A plausible typo, a valid-but-unoffered zone, and blank: all no.
    expect(isOfferedTimeZone('Europe/Helsinky')).toBe(false);
    expect(isOfferedTimeZone('Pacific/Chatham')).toBe(false);
    expect(isOfferedTimeZone('')).toBe(false);
    expect(isOfferedTimeZone('  Europe/Helsinki  ')).toBe(false);
  });
});

describe('the membership windows on offer', () => {
  it('offers exactly the two Elixia sells, each with a label naming its tier', () => {
    expect(MEMBERSHIP_OPTIONS.map((o) => o.days)).toEqual([7, 14]);
    expect(MEMBERSHIP_OPTIONS.map((o) => o.label).join(' ')).toMatch(/7 days.*14 days/);
  });

  it('refuses a window nobody was offered', () => {
    expect(isMembershipWindow(7)).toBe(true);
    expect(isMembershipWindow(14)).toBe(true);
    expect(isMembershipWindow(10)).toBe(false);
    expect(isMembershipWindow(0)).toBe(false);
    expect(isMembershipWindow(7.5)).toBe(false);
    expect(isMembershipWindow(Number.NaN)).toBe(false);
  });
});
