import { describe, expect, it, vi } from 'vitest';
import {
  API_DISCOVERED,
  ClassNotListedError,
  ElixiaClient,
  buildBookingBody,
  classifyBookingResponse,
  collectClassOptions,
  extractDataProps,
  findClassId,
  findClubIdByName,
  listClubOptions,
  performElixiaLogin,
} from '../lib/elixia';
import { isRetryable } from '../lib/types';
import type { StoredTokens, Subscription } from '../lib/types';

/**
 * Fixtures below are trimmed copies of what discovery actually captured — the
 * real `data-props` shape, the real booking payloads, the real Finnish error
 * body. Keeping them faithful is the point: these tests are the only thing
 * that will notice if Elixia's shapes drift, since nothing else here talks to
 * the live site.
 */

const NOW = 1_700_000_000_000;
const BASE = 'https://fake.elixia.test';
const AUTH = 'https://fake.auth.test';

const tokens: StoredTokens = { accessToken: '.SATS_GROUP_AUTH=x', expiresAtMs: NOW, updatedAtMs: NOW };

function clubOptions() {
  return {
    queryName: 'clubIds',
    options: [
      { value: '740', label: 'Iso Omena', name: 'clubIds' },
      { value: '741', label: 'Circus', name: 'clubIds' },
    ],
  };
}

/**
 * A second group of clubs, because `categories` is an array: the real page
 * splits its 226 clubs across several `clubIds` nodes rather than listing them
 * all in one.
 */
function moreClubOptions() {
  return {
    queryName: 'clubIds',
    options: [
      { value: '742', label: 'Sello', name: 'clubIds' },
      // Repeated from the first group, as a club served by two filters would be.
      { value: '740', label: 'Iso Omena', name: 'clubIds' },
    ],
  };
}

/** Mirrors the real nesting depth, so the finder is exercised as a tree walk. */
function filtersFixture() {
  return {
    filters: {
      filters: [
        {
          title: 'Keskus',
          formContentOptions: {
            content: { content: [{ categories: [clubOptions(), moreClubOptions()] }] },
          },
        },
      ],
    },
  };
}

function scheduleFixture() {
  return {
    filters: filtersFixture(),
    schedule: {
      hasResults: true,
      dateList: {
        dates: [
          { isoDate: '2026-08-21', disabled: false },
          { isoDate: '2026-08-22', disabled: false },
          // Beyond Elixia's published horizon: in the picker, but no classes.
          { isoDate: '2026-09-05', disabled: true },
        ],
      },
      events: [
        {
          date: '2026-08-21',
          bookEndpoint: '/api/book',
          events: [
            {
              id: '741p75627',
              isBooked: false,
              hasWaitingList: true,
              waitingListCount: 14,
              metadata: {
                name: 'Cycling The Journey',
                clubName: 'Circus',
                startsAt: '2026-08-21T17:00:00+03:00',
                time: '17:00',
                duration: 75,
              },
            },
            {
              id: '741p70111',
              isBooked: false,
              hasWaitingList: true,
              waitingListCount: 12,
              metadata: {
                name: 'HIIT Run & Box',
                clubName: 'Circus',
                startsAt: '2026-08-21T18:30:00+03:00',
                time: '18:30',
                duration: 60,
              },
            },
            // The same class runs twice that evening. Only the start time
            // tells the two occurrences apart, and they have different ids.
            {
              id: '741p70112',
              isBooked: false,
              hasWaitingList: false,
              waitingListCount: 0,
              metadata: {
                name: 'HIIT Run & Box',
                clubName: 'Circus',
                startsAt: '2026-08-21T20:00:00+03:00',
                time: '20:00',
                duration: 60,
              },
            },
          ],
        },
        { date: '2026-09-05', bookEndpoint: '/api/book', events: [] },
      ],
    },
  };
}

/** A page with no `clubIds` carries no schedule at all — see docs/api.md §4. */
function unfilteredFixture() {
  return { filters: filtersFixture(), schedule: { query: { clubIds: '' } } };
}

function event(name: string, time: string) {
  return {
    id: `741p${name.length}${time.replace(':', '')}`,
    isBooked: false,
    hasWaitingList: false,
    waitingListCount: 0,
    metadata: { name, clubName: 'Circus', startsAt: `2026-08-24T${time}:00+03:00`, time, duration: 60 },
  };
}

function oneClassFixture({ date, name, time }: { date: string; name: string; time: string }) {
  return { schedule: { events: [{ date, events: [event(name, time)] }] } };
}

/** The same two weekly classes as the listing publishes them: once per week. */
function twoWeekFixture() {
  return {
    schedule: {
      events: [
        { date: '2026-08-24', events: [event('Bodypump', '09:00')] }, // Monday
        { date: '2026-08-27', events: [event('Bodypump', '18:00')] }, // Thursday
        { date: '2026-08-31', events: [event('Bodypump', '09:00')] }, // Monday again
        { date: '2026-09-03', events: [event('Bodypump', '18:00')] }, // Thursday again
      ],
    },
  };
}

function pageHtml(props: unknown): string {
  return `<!doctype html><html><body><script data-props="true" type="application/json">${JSON.stringify(
    props,
  )}</script></body></html>`;
}

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  id: 's1',
  userId: 'u1',
  center: '741',
  className: 'HIIT Run & Box',
  weekday: 'friday',
  startTime: '18:30',
  priority: 1,
  enabled: true,
  createdAtMs: NOW,
  ...over,
});

describe('the discovery flag', () => {
  it('is on, because login, listing and booking are all implemented', () => {
    expect(API_DISCOVERED).toBe(true);
  });
});

describe('extractDataProps', () => {
  it('reads the schedule page props out of the embedded script tag', () => {
    const props = extractDataProps(pageHtml(scheduleFixture()));
    expect(props.schedule?.events?.[0]?.date).toBe('2026-08-21');
  });

  it('fails loudly when the page carries no props, rather than returning empty', () => {
    // Silently returning {} here would surface much later as "class not
    // listed", sending the retry loop after a page that is not a schedule.
    expect(() => extractDataProps('<html><body>maintenance</body></html>')).toThrow(
      /no data-props script/,
    );
  });
});

describe('findClubIdByName', () => {
  it('maps a centre name to the numeric club id the API filters on', () => {
    expect(findClubIdByName(scheduleFixture(), 'Circus')).toBe('741');
  });

  it('ignores case and surrounding space, since the name is user-typed', () => {
    expect(findClubIdByName(scheduleFixture(), '  circus ')).toBe('741');
  });

  it('finds a centre listed in a later filter group, not just the first', () => {
    // The regression that hid Circus from the chooser also broke resolution:
    // a subscription whose centre lives in a later group would stop resolving
    // and quietly book nothing.
    expect(findClubIdByName(scheduleFixture(), 'Sello')).toBe('742');
  });

  it('returns null for a centre that does not exist', () => {
    expect(findClubIdByName(scheduleFixture(), 'Nowhere')).toBeNull();
  });
});

describe('listClubOptions', () => {
  it('lists every centre the filter offers, from every group it offers them in', () => {
    // The clubs are split across several `clubIds` nodes, so stopping at the
    // first one silently hides most of the gym's centres — and hid Circus.
    // Alphabetical because the merged order is otherwise arbitrary, and a
    // 226-item dropdown is only usable in a predictable order.
    expect(listClubOptions(scheduleFixture())).toEqual([
      { id: '741', name: 'Circus' },
      { id: '740', name: 'Iso Omena' },
      { id: '742', name: 'Sello' },
    ]);
  });

  it('lists a club once when two filter groups both offer it', () => {
    const ids = listClubOptions(scheduleFixture()).map((c) => c.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('is empty rather than throwing when the page carries no filter tree', () => {
    expect(listClubOptions({})).toEqual([]);
  });
});

describe('collectClassOptions', () => {
  it('turns the published schedule into the weekly classes a user can pick', () => {
    // 2026-08-21 is a Friday; the weekday is derived from the date rather than
    // stored anywhere on the event.
    expect(collectClassOptions(scheduleFixture())).toEqual([
      { className: 'Cycling The Journey', weekday: 'friday', startTime: '17:00' },
      { className: 'HIIT Run & Box', weekday: 'friday', startTime: '18:30' },
      { className: 'HIIT Run & Box', weekday: 'friday', startTime: '20:00' },
    ]);
  });

  it('collapses the same weekly class appearing on both published weeks', () => {
    // The listing spans ~14 days, so every weekly class occurs twice in it.
    // Offering it twice would put two identical rows in the chooser.
    const props = twoWeekFixture();
    expect(collectClassOptions(props)).toEqual([
      { className: 'Bodypump', weekday: 'monday', startTime: '09:00' },
      { className: 'Bodypump', weekday: 'thursday', startTime: '18:00' },
    ]);
  });

  it('pads the displayed time so it matches what a subscription stores', () => {
    // The schedule renders "9:00"; subscriptions and findClassId use "09:00".
    // Storing the unpadded form would resolve to nothing at T-0.
    const props = oneClassFixture({ date: '2026-08-24', name: 'Yoga', time: '9:00' });
    expect(collectClassOptions(props)).toEqual([
      { className: 'Yoga', weekday: 'monday', startTime: '09:00' },
    ]);
  });

  it('orders the week from Monday, then by time, so the list reads like a timetable', () => {
    const props = {
      schedule: {
        events: [
          { date: '2026-08-23', events: [event('Sunday Spin', '10:00')] }, // Sunday
          { date: '2026-08-24', events: [event('Late Yoga', '19:00'), event('Dawn Yoga', '06:30')] },
        ],
      },
    };
    expect(collectClassOptions(props).map((c) => `${c.weekday} ${c.startTime} ${c.className}`)).toEqual([
      'monday 06:30 Dawn Yoga',
      'monday 19:00 Late Yoga',
      'sunday 10:00 Sunday Spin',
    ]);
  });

  it('skips a day whose date is not a real date instead of inventing a weekday', () => {
    const props = { schedule: { events: [{ date: 'later', events: [event('Ghost', '10:00')] }] } };
    expect(collectClassOptions(props)).toEqual([]);
  });

  it('is empty for a page with no schedule, which is what an unfiltered page is', () => {
    expect(collectClassOptions(extractDataProps(pageHtml(unfilteredFixture())))).toEqual([]);
  });
});

describe('findClassId', () => {
  it('picks the class matching date, name and start time', () => {
    expect(findClassId(scheduleFixture(), subscription(), '2026-08-21')).toBe('741p70111');
  });

  it('distinguishes two runs of the same class by start time', () => {
    // Name alone is ambiguous here — picking the wrong one books the wrong
    // hour, which is the failure a user would actually notice.
    const early = subscription({ className: 'HIIT Run & Box', startTime: '18:30' });
    const late = subscription({ className: 'HIIT Run & Box', startTime: '20:00' });
    expect(findClassId(scheduleFixture(), early, '2026-08-21')).toBe('741p70111');
    expect(findClassId(scheduleFixture(), late, '2026-08-21')).toBe('741p70112');
  });

  it('accepts an unpadded start time, which is what a user types', () => {
    const cycling = subscription({ className: 'Cycling The Journey', startTime: '9:00' });
    // "9:00" must not be read as the padded "09:00" of some other slot, nor
    // silently match 17:00 — it simply is not on the schedule.
    expect(() => findClassId(scheduleFixture(), cycling, '2026-08-21')).toThrow(
      ClassNotListedError,
    );
  });

  it('reports a date past the published schedule as not-yet-open, not as an error', () => {
    // This is the ordinary state before T-0, so it has to be the retryable
    // outcome rather than something that aborts the run.
    const err = (() => {
      try {
        findClassId(scheduleFixture(), subscription(), '2026-09-05');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ClassNotListedError);
    // Says "published", not "bookable": the disabled flag marks Elixia's
    // publishing horizon, which is the same for every tier — not this
    // member's booking window (docs/api.md §4).
    expect(err?.message).toMatch(/beyond the published schedule/);
  });

  it('reports a date absent from the schedule entirely', () => {
    expect(() => findClassId(scheduleFixture(), subscription(), '2027-01-01')).toThrow(
      /not in the schedule at all/,
    );
  });

  it('reports a class name that is listed on no matching slot that day', () => {
    const gone = subscription({ className: 'Bodypump' });
    expect(() => findClassId(scheduleFixture(), gone, '2026-08-21')).toThrow(ClassNotListedError);
  });
});

describe('ElixiaClient.resolveClassId', () => {
  it('fetches the schedule filtered by club id and returns the class id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(url.toString()).toBe(`${BASE}/varaukset?clubIds=741`);
      return new Response(pageHtml(scheduleFixture()), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ElixiaClient({ fetchImpl, baseUrl: BASE });
    await expect(client.resolveClassId(tokens, subscription(), '2026-08-21')).resolves.toBe(
      '741p70111',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the session cookie, since an anonymous page would not show bookings', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('cookie')).toBe('.SATS_GROUP_AUTH=x');
      return new Response(pageHtml(scheduleFixture()), { status: 200 });
    }) as unknown as typeof fetch;

    await new ElixiaClient({ fetchImpl, baseUrl: BASE }).resolveClassId(
      tokens,
      subscription(),
      '2026-08-21',
    );
  });

  it('resolves a centre given by name, at the cost of one extra request', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      urls.push(u);
      return new Response(
        pageHtml(u.includes('clubIds') ? scheduleFixture() : unfilteredFixture()),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new ElixiaClient({ fetchImpl, baseUrl: BASE });
    await expect(
      client.resolveClassId(tokens, subscription({ center: 'Circus' }), '2026-08-21'),
    ).resolves.toBe('741p70111');

    expect(urls).toEqual([`${BASE}/varaukset`, `${BASE}/varaukset?clubIds=741`]);
  });

  it('names the unknown centre rather than failing as "class not listed"', async () => {
    const fetchImpl = (async () =>
      new Response(pageHtml(unfilteredFixture()), { status: 200 })) as typeof fetch;

    await expect(
      new ElixiaClient({ fetchImpl, baseUrl: BASE }).resolveClassId(
        tokens,
        subscription({ center: 'Atlantis' }),
        '2026-08-21',
      ),
    ).rejects.toThrow(/No Elixia centre named "Atlantis"/);
  });
});

describe('ElixiaClient.listCenters / listClasses', () => {
  it('lists centres from the unfiltered page, which is the only place the club list exists', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(url.toString()).toBe(`${BASE}/varaukset`);
      return new Response(pageHtml(unfilteredFixture()), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(new ElixiaClient({ fetchImpl, baseUrl: BASE }).listCenters(tokens)).resolves.toEqual([
      { id: '741', name: 'Circus' },
      { id: '740', name: 'Iso Omena' },
      { id: '742', name: 'Sello' },
    ]);
  });

  it('fetches a centre by name filtered by its club id, since an unfiltered page has no classes', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      urls.push(u);
      return new Response(pageHtml(u.includes('clubIds') ? scheduleFixture() : unfilteredFixture()), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const classes = await new ElixiaClient({ fetchImpl, baseUrl: BASE }).listClasses(tokens, 'Circus');

    expect(urls).toEqual([`${BASE}/varaukset`, `${BASE}/varaukset?clubIds=741`]);
    expect(classes).toContainEqual({
      className: 'HIIT Run & Box',
      weekday: 'friday',
      startTime: '18:30',
    });
  });

  it('says which centre was unknown rather than returning an empty timetable', async () => {
    // An empty list would read as "this centre has no classes", sending the
    // user looking for a fault at the gym rather than at the name.
    const fetchImpl = (async () =>
      new Response(pageHtml(unfilteredFixture()), { status: 200 })) as typeof fetch;

    await expect(
      new ElixiaClient({ fetchImpl, baseUrl: BASE }).listClasses(tokens, 'Atlantis'),
    ).rejects.toThrow(/No Elixia centre named "Atlantis"/);
  });
});

describe('ElixiaClient.book', () => {
  it('posts only the class id, with no waitlist flag of any kind', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe(`${BASE}/api/book`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ id: '741p70111' });
      return new Response(
        JSON.stringify({ payload: { status: 'Booked', participationId: '741p1295323' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const outcome = await new ElixiaClient({ fetchImpl, baseUrl: BASE }).book(tokens, '741p70111');
    expect(outcome).toEqual({ kind: 'booked', bookingId: '741p1295323' });
  });
});

describe('buildBookingBody', () => {
  it('is exactly the observed payload', () => {
    expect(buildBookingBody('741p71244')).toBe('{"id":"741p71244"}');
  });
});

describe('performElixiaLogin', () => {
  function formHtml(action: string): string {
    return `<form class="form" action="${action.replace(/&/g, '&amp;')}" method="post">login</form>`;
  }

  it('walks the real redirect chain (kirjaudu-sisaan -> Keycloak -> return) into a session cookie', async () => {
    const authAction = `${AUTH}/realms/sats/login-actions/authenticate?session_code=abc&execution=def&client_id=sats-web`;

    const routes = new Map<string, () => Response>([
      [
        `${BASE}/kirjaudu-sisaan?onSuccess=%2Fomat-sivut`,
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `${BASE}/api/sats-group-auth-log-in?redirect=%2Fomat-sivut` },
          }),
      ],
      [
        `${BASE}/api/sats-group-auth-log-in?redirect=%2Fomat-sivut`,
        () =>
          new Response(null, {
            status: 303,
            headers: {
              location: `${AUTH}/realms/sats/protocol/openid-connect/auth?client_id=sats-web`,
            },
          }),
      ],
      [
        `${AUTH}/realms/sats/protocol/openid-connect/auth?client_id=sats-web`,
        () =>
          new Response(formHtml(authAction), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ],
      [
        authAction,
        () => {
          const headers = new Headers();
          headers.append('location', `${BASE}/api/sats-group-auth-log-in-return?code=xyz`);
          return new Response(null, { status: 302, headers });
        },
      ],
      [
        `${BASE}/api/sats-group-auth-log-in-return?code=xyz`,
        () => {
          const headers = new Headers();
          headers.append('location', '/omat-sivut');
          headers.append(
            'set-cookie',
            '.SATS_GROUP_AUTH=part1; Max-Age=1209600; Path=/; Secure; HttpOnly; SameSite=Lax',
          );
          headers.append(
            'set-cookie',
            '.SATS_GROUP_AUTH_00=part2; Max-Age=1209600; Path=/; Secure; HttpOnly; SameSite=Lax',
          );
          return new Response(null, { status: 302, headers });
        },
      ],
      [`${BASE}/omat-sivut`, () => new Response('ok', { status: 200 })],
    ]);

    const fetchImpl = (async (url: string | URL) => {
      const route = routes.get(url.toString());
      if (!route) throw new Error(`unexpected fetch in test: ${url}`);
      return route();
    }) as typeof fetch;

    const result = await performElixiaLogin(fetchImpl, BASE, 'user@example.com', 'hunter2', NOW);

    expect(result.accessToken).toBe('.SATS_GROUP_AUTH=part1; .SATS_GROUP_AUTH_00=part2');
    // Observed Max-Age (docs/api.md §1): 14 days.
    expect(result.expiresAtMs).toBe(NOW + 1_209_600_000);
    // There is no refresh token in this flow at all.
    expect(result.refreshToken).toBeUndefined();
  });

  it('treats a re-rendered login form as rejected credentials, not a crash', async () => {
    // Keycloak's real failure behaviour (docs/api.md §1): wrong credentials
    // come back as HTTP 200 with the same form, never as an error status.
    const authAction = `${AUTH}/realms/sats/login-actions/authenticate?session_code=abc`;
    const html = formHtml(authAction);

    const fetchImpl = (async (url: string | URL) => {
      const key = url.toString();
      if (key === `${BASE}/kirjaudu-sisaan?onSuccess=%2Fomat-sivut` || key === authAction) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`unexpected fetch in test: ${key}`);
    }) as typeof fetch;

    await expect(
      performElixiaLogin(fetchImpl, BASE, 'user@example.com', 'wrong', NOW),
    ).rejects.toThrow(/rejected the email or password/);
  });

  it('reports a clear error when the login page has no recognisable form', async () => {
    const fetchImpl = (async () =>
      new Response('<html>not a login page any more</html>', { status: 200 })) as typeof fetch;

    await expect(performElixiaLogin(fetchImpl, BASE, 'user@example.com', 'pw', NOW)).rejects.toThrow(
      /could not find the Keycloak sign-in form/,
    );
  });
});

describe('classifyBookingResponse', () => {
  it('reads a Booked response, keyed by participationId (docs/api.md §5)', () => {
    const body = JSON.stringify({
      payload: { status: 'Booked', participationId: '741p1295323', hasWaitingList: false },
    });
    expect(classifyBookingResponse(200, body)).toEqual({ kind: 'booked', bookingId: '741p1295323' });
  });

  it('reads an OnWaitingList response as a success with its position (docs/api.md §6)', () => {
    const body = JSON.stringify({
      payload: {
        status: 'OnWaitingList',
        participationId: '741p1299243',
        waitingListPosition: 13,
        hasWaitingList: true,
      },
    });
    expect(classifyBookingResponse(200, body)).toEqual({
      kind: 'waitlisted',
      bookingId: '741p1299243',
      position: 13,
    });
  });

  it('does not retry a waiting-list placement — it is the final answer', () => {
    expect(isRetryable({ kind: 'waitlisted', position: 13 })).toBe(false);
  });

  it('classifies the real Finnish 409 body as an overlapping booking', () => {
    // Verbatim from the capture. Error text is localized, which is exactly why
    // classification keys on the status code and never on the message.
    const body = JSON.stringify({ message: 'Sinulla on voimassa oleva varaus päällekkäin.' });
    const outcome = classifyBookingResponse(409, body);
    expect(outcome.kind).toBe('already-booked');
    expect(isRetryable(outcome)).toBe(false);
  });

  it('carries the server message through, so the notification says what happened', () => {
    const body = JSON.stringify({ message: 'Sinulla on voimassa oleva varaus päällekkäin.' });
    expect(classifyBookingResponse(409, body)).toEqual({
      kind: 'already-booked',
      detail: 'Sinulla on voimassa oleva varaus päällekkäin.',
    });
  });

  it('classifies a Finnish 403 as permanent, not as something to retry', () => {
    // "Booking has been blocked" — a membership problem. Retrying it at T-0
    // would burn the whole budget on a request that can never succeed.
    const outcome = classifyBookingResponse(403, JSON.stringify({ message: 'Varausten teko on estetty.' }));
    expect(outcome).toEqual({ kind: 'unauthorized', detail: 'Varausten teko on estetty.' });
    expect(isRetryable(outcome)).toBe(false);
  });

  it('classifies a Finnish 401 as a lapsed session', () => {
    const outcome = classifyBookingResponse(
      401,
      JSON.stringify({ message: 'Sinun on kirjauduttava sisään, jotta voit tehdä varauksen.' }),
    );
    expect(outcome.kind).toBe('unauthorized');
    expect(isRetryable(outcome)).toBe(false);
  });

  it('maps 429 to rate-limited and honours Retry-After in seconds', () => {
    const outcome = classifyBookingResponse(429, '', new Headers({ 'retry-after': '3' }));
    expect(outcome).toEqual({ kind: 'rate-limited', retryAfterMs: 3000 });
  });

  it('handles a Retry-After given as an HTTP date', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const outcome = classifyBookingResponse(429, '', new Headers({ 'retry-after': future }));
    expect(outcome.kind).toBe('rate-limited');
    expect((outcome as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('treats a 404 as retryable, since an id can 404 right as it becomes bookable', () => {
    const outcome = classifyBookingResponse(404, '');
    expect(outcome.kind).toBe('too-early');
    expect(isRetryable(outcome)).toBe(true);
  });

  it('treats 400 and 5xx as retryable errors', () => {
    for (const status of [400, 500, 503]) {
      const outcome = classifyBookingResponse(status, JSON.stringify({ message: 'Jotain meni pieleen.' }));
      expect(outcome.kind).toBe('error');
      expect(isRetryable(outcome)).toBe(true);
    }
  });

  it('treats an unrecognised 2xx shape as an error rather than a silent success', () => {
    expect(classifyBookingResponse(200, '{"payload":{"status":"SomethingNew"}}').kind).toBe('error');
  });

  it('treats a non-JSON 2xx body as an error rather than a silent success', () => {
    expect(classifyBookingResponse(200, 'OK').kind).toBe('error');
  });

  it('truncates a huge error body so it cannot flood the log or notification', () => {
    const outcome = classifyBookingResponse(500, 'x'.repeat(10_000));
    expect((outcome as { detail: string }).detail.length).toBeLessThan(400);
  });
});
