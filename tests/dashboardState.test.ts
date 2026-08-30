import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  classStatus,
  dashboardScreen,
  describeUnavailable,
  describeUnlisted,
  formatClassDate,
  formatReleaseAt,
  loadDashboard,
  tabFromSearch,
  type DashboardLoad,
} from '@/lib/dashboardState';
import type { DashboardView } from '@/lib/service';

const VIEW = { account: { elixiaStatus: 'unlinked' } } as unknown as DashboardView;

/** A Response-alike, so these tests do not depend on a DOM or a real server. */
function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (path: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadDashboard', () => {
  it("reports the server's explanation when /api/me fails, rather than nothing", async () => {
    stubFetch(async () =>
      respond(500, { error: 'ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32' }),
    );

    expect(await loadDashboard()).toEqual({
      status: 'error',
      message: 'ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    });
  });

  it('treats a rejected session as signed out, not as an error', async () => {
    stubFetch(async () => respond(401, { error: 'Not signed in' }));

    expect(await loadDashboard()).toEqual({ status: 'signed-out' });
  });

  it('reads a 428 as an account that still has to be set up, not as an error', async () => {
    // The status is the whole routing decision: nothing is wrong with the
    // request or the session, so showing the server's message on an error card
    // would leave the visitor reading about a precondition with no way to meet
    // it. They get the setup pages instead.
    stubFetch(async () => respond(428, { error: 'Finish setting up your account first' }));

    expect(await loadDashboard()).toEqual({ status: 'setup' });
  });

  it('reports an unreachable server rather than surfacing a fetch internal', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    const load = await loadDashboard();
    expect(load.status).toBe('error');
    expect(load).toMatchObject({ message: expect.stringContaining('Could not reach') });
  });

  it('falls back to the status when the failure body carries no message', async () => {
    stubFetch(async () => respond(502, {}));

    expect(await loadDashboard()).toEqual({ status: 'error', message: 'Request failed: 502' });
  });

  it('returns the dashboard on success', async () => {
    stubFetch(async () => respond(200, VIEW));

    expect(await loadDashboard()).toEqual({ status: 'ok', view: VIEW });
  });
});

describe('apiRequest', () => {
  it('throws an ApiError carrying the status, so callers can tell 401 apart', async () => {
    stubFetch(async () => respond(409, { error: 'No Elixia account linked' }));

    const err = await apiRequest('/api/elixia', { method: 'DELETE' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('No Elixia account linked');
  });
});

describe('dashboardScreen', () => {
  const pending = { sessionPending: true, signedIn: false, load: null };

  it('waits while the session is still being resolved', () => {
    expect(dashboardScreen(pending)).toEqual({ kind: 'loading' });
  });

  it('offers sign-in when nobody is signed in', () => {
    expect(dashboardScreen({ sessionPending: false, signedIn: false, load: null })).toEqual({
      kind: 'signed-out',
    });
  });

  it('waits while the first dashboard request is in flight', () => {
    expect(dashboardScreen({ sessionPending: false, signedIn: true, load: null })).toEqual({
      kind: 'loading',
    });
  });

  // The bug this whole module exists for: a failed /api/me used to collapse to
  // null, which the component could not tell from "still loading", so signing in
  // left the page on "Loading your account…" forever.
  it('shows the failure instead of loading forever when the dashboard cannot be loaded', () => {
    const load: DashboardLoad = { status: 'error', message: 'ENCRYPTION_KEY is not set.' };

    expect(dashboardScreen({ sessionPending: false, signedIn: true, load })).toEqual({
      kind: 'error',
      message: 'ENCRYPTION_KEY is not set.',
    });
  });

  it('sends the visitor back to sign-in when the server rejects a session the client still holds', () => {
    expect(
      dashboardScreen({ sessionPending: false, signedIn: true, load: { status: 'signed-out' } }),
    ).toEqual({ kind: 'signed-out' });
  });

  it('shows the setup pages to an account that has not been through them', () => {
    expect(
      dashboardScreen({ sessionPending: false, signedIn: true, load: { status: 'setup' } }),
    ).toEqual({ kind: 'setup' });
  });

  it('shows the dashboard once it loads', () => {
    expect(
      dashboardScreen({ sessionPending: false, signedIn: true, load: { status: 'ok', view: VIEW } }),
    ).toEqual({ kind: 'dashboard', view: VIEW });
  });
});

describe('describeUnlisted', () => {
  it('says nothing about a class that is still on the schedule', () => {
    expect(describeUnlisted(undefined)).toBeNull();
  });

  it('dates the absence, so a holiday week reads differently from a closure', () => {
    const since = Date.parse('2026-08-18T03:00:00Z');
    const message = describeUnlisted(since)!;

    expect(message).toContain(new Date(since).toLocaleDateString());
    expect(message).toMatch(/nothing can be booked/i);
  });

  it('does not claim the class was deleted, which is more than absence proves', () => {
    // Elixia not publishing a class is all this app can see. Saying it was
    // cancelled would be a guess the owner then acts on.
    expect(describeUnlisted(Date.now())).toMatch(/renamed, moved or dropped/i);
  });
});

describe('describeUnavailable', () => {
  it('says nothing when there is no upcoming occurrence to check', () => {
    expect(describeUnavailable(null, undefined)).toBeNull();
  });

  it('says nothing when the flagged date is not the one currently upcoming', () => {
    // The flag is only ever as fresh as the last check, and the occurrence it
    // named can have rolled forward since — nothing to say until a fresh
    // check catches up.
    expect(describeUnavailable('2026-08-18', '2026-08-11')).toBeNull();
  });

  it('says nothing when the upcoming occurrence has not been flagged', () => {
    expect(describeUnavailable('2026-08-11', undefined)).toBeNull();
  });

  it('names the date when the upcoming occurrence is confirmed missing', () => {
    const message = describeUnavailable('2026-08-11', '2026-08-11')!;
    expect(message).toContain('2026-08-11');
    expect(message).toMatch(/not on Elixia's schedule/i);
  });

  it('says the class may still run on a later date, since some are one-off', () => {
    // Unlike a withdrawn class, this must never read as a permanent removal.
    const message = describeUnavailable('2026-08-11', '2026-08-11')!;
    expect(message).toMatch(/one-off|later date/i);
  });
});

describe('formatClassDate', () => {
  it('reads a calendar date as itself, not shifted by the reader\'s own timezone', () => {
    // Parsed in UTC deliberately (see the function's own comment): a reader
    // west of UTC parsing this date-only string in local time would see it
    // roll back to the day before.
    expect(formatClassDate('2026-09-09')).toBe('Wed 9 Sep');
  });

  it('is a fixed, unambiguous format rather than day/month digits', () => {
    // "09/09" and "02/09" are exactly the pair a US-locale reader and
    // everyone else disagree about — spelling the month out removes the
    // question entirely.
    expect(formatClassDate('2026-09-02')).not.toMatch(/\d\/\d/);
  });
});

describe('formatReleaseAt', () => {
  it('names the weekday, day and month, then a 24h time', () => {
    const iso = new Date(2026, 8, 2, 19, 0).toISOString();
    expect(formatReleaseAt(iso)).toBe('Wed 2 Sep, 19:00');
  });

  it('pads a single-digit minute, so the row does not misalign next to others', () => {
    const iso = new Date(2026, 8, 2, 7, 5).toISOString();
    expect(formatReleaseAt(iso)).toBe('Wed 2 Sep, 07:05');
  });
});

describe('classStatus', () => {
  it('says Paused before anything else, even when a release time exists', () => {
    // A paused class keeps its computed release around (so resuming it does
    // not need a fresh reindex to look right) — but showing that time would
    // read as still active.
    expect(
      classStatus({ enabled: false, notFound: false, nextReleaseAt: '2026-09-02T16:00:00.000Z' }),
    ).toEqual({ text: 'Paused', emphasize: false });
  });

  it('flags a class missing from the schedule ahead of a stale release time', () => {
    expect(
      classStatus({ enabled: true, notFound: true, nextReleaseAt: '2026-09-02T16:00:00.000Z' }),
    ).toEqual({ text: "Not on Elixia's schedule", emphasize: false });
  });

  it('shows the formatted opening time, and marks it worth emphasis', () => {
    const iso = new Date(2026, 8, 2, 19, 0).toISOString();
    expect(classStatus({ enabled: true, notFound: false, nextReleaseAt: iso })).toEqual({
      text: 'Opens Wed 2 Sep, 19:00',
      emphasize: true,
    });
  });

  it('says there is no upcoming release when nothing else explains the gap', () => {
    expect(classStatus({ enabled: true, notFound: false, nextReleaseAt: null })).toEqual({
      text: 'No upcoming release',
      emphasize: false,
    });
  });
});

describe('tabFromSearch', () => {
  // Regression coverage for a real bug: the dashboard used to always open on
  // the Classes tab, so leaving Settings for /account/security to change a
  // password and clicking Back landed the visitor back on Classes instead of
  // where they had been.
  it('reopens the tab named in the query string', () => {
    expect(tabFromSearch('?tab=settings')).toBe('settings');
    expect(tabFromSearch('?tab=activity')).toBe('activity');
  });

  it('defaults to classes when there is no tab param', () => {
    expect(tabFromSearch('')).toBe('classes');
  });

  it('defaults to classes rather than trusting an unrecognized value', () => {
    expect(tabFromSearch('?tab=not-a-real-tab')).toBe('classes');
  });
});
