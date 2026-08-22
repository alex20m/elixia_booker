import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  dashboardScreen,
  describeUnlisted,
  loadDashboard,
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
