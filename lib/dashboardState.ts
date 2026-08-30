/**
 * What the dashboard shows, decided outside React.
 *
 * The choice used to live inline in the component as a chain of early returns,
 * and a failed `/api/me` collapsed to `null` — a value the component could not
 * tell apart from "still loading". So a deployment that was merely missing an
 * environment variable sat on "Loading your account…" forever, while the server
 * was returning a 500 whose body said exactly what to set. Naming every outcome
 * here means a failure has somewhere to go, and it can be tested without a
 * browser.
 */

import type { DashboardView } from './service';

/** "monday" as a person would write it. Weekdays are stored lowercased. */
export const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What to say about a class Elixia no longer publishes, or null when there is
 * nothing to say.
 *
 * Decided here rather than in the component for the same reason the rest of
 * this file exists: it is a rule about what the visitor is told, and it can be
 * checked without a browser. The wording carries the date because that is what
 * makes it actionable — a class missing since yesterday is very likely a
 * holiday week, one missing for a month is gone — and it never claims the
 * class was deleted, because all this app can observe is absence.
 */
export function describeUnlisted(unlistedSinceMs: number | undefined): string | null {
  if (unlistedSinceMs === undefined) return null;
  const since = new Date(unlistedSinceMs).toLocaleDateString();
  return (
    `Not on Elixia's schedule since ${since}, so nothing can be booked. ` +
    `It may have been renamed, moved or dropped — check the timetable and re-add it.`
  );
}

/**
 * What to say about a class whose very next occurrence is confirmed absent
 * from Elixia's schedule, or null when there is nothing to say.
 *
 * Unlike `describeUnlisted`, this is about one specific date rather than the
 * class having gone altogether: some Elixia classes are one-off, so a date
 * missing this week says nothing about the date after it. Compares against
 * `nextClassDate` rather than trusting the stored flag alone — the flag is
 * only ever as fresh as the last check, and the occurrence it named can have
 * rolled forward since, in which case there is nothing to say until a fresh
 * check catches up.
 */
export function describeUnavailable(
  nextClassDate: string | null,
  unavailableClassDate: string | undefined,
): string | null {
  if (nextClassDate === null || unavailableClassDate !== nextClassDate) return null;
  return (
    `Not on Elixia's schedule for ${nextClassDate}, so it will not be booked for this date. ` +
    `This class can run one-off, so it may still be there for a later date — checked again ` +
    `every night.`
  );
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * "Wed 9 Sep" for a calendar date "YYYY-MM-DD".
 *
 * Read in UTC rather than in the reader's own timezone, the same reasoning
 * `weekdayOfIsoDate` (lib/elixia.ts) gives: a date-only string names a
 * calendar day, and parsing it in any zone but UTC can walk that day
 * backwards or forwards across midnight depending on where the reader is.
 */
export function formatClassDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/**
 * "Wed 2 Sep, 19:00" for a release instant.
 *
 * A fixed format rather than `toLocaleString()`, which renders the day and
 * month as bare digits in whatever order the reader's own locale prefers —
 * exactly the pair (`02/09` vs `09/02`) a US-locale browser and everyone else
 * disagree about, for a value where being misread has real consequences.
 * Read in the reader's own local time (not UTC, unlike `formatClassDate`
 * above): this names an instant, and the whole point is showing it at the
 * wall-clock time it actually is for whoever is looking at the screen.
 */
export function formatReleaseAt(iso: string): string {
  const d = new Date(iso);
  return (
    `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}, ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** What `classStatus` reports: the line to show, and whether it is good news. */
export interface ClassStatus {
  text: string;
  /** Whether this is an actual opening time, worth the accent colour. */
  emphasize: boolean;
}

/**
 * The one-line status shown where a release time goes in the class list.
 *
 * Always returns something, so a row is never left blank where a date and
 * time are expected — silence there reads as broken, not as "there is
 * nothing to add". `notFound` covers both ways a class can be missing from
 * Elixia's schedule (withdrawn altogether, or absent for one specific date);
 * either already gets its own detailed banner right below the row, so this
 * is deliberately not that explanation — it is the glanceable version of the
 * same fact, for a list read a row at a time rather than one row read
 * closely.
 */
export function classStatus(input: {
  enabled: boolean;
  notFound: boolean;
  nextReleaseAt: string | null;
}): ClassStatus {
  if (!input.enabled) return { text: 'Paused', emphasize: false };
  if (input.notFound) return { text: "Not on Elixia's schedule", emphasize: false };
  if (input.nextReleaseAt) {
    return { text: `Opens ${formatReleaseAt(input.nextReleaseAt)}`, emphasize: true };
  }
  return { text: 'No upcoming release', emphasize: false };
}

/** A failed request, carrying the status so callers can tell 401 from the rest. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The outcome of asking the server for the dashboard. */
export type DashboardLoad =
  | { status: 'ok'; view: DashboardView }
  | { status: 'signed-out' }
  | { status: 'setup' }
  | { status: 'error'; message: string };

/** What the visitor should be looking at. */
export type Screen =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'setup' }
  | { kind: 'error'; message: string }
  | { kind: 'dashboard'; view: DashboardView };

/**
 * The status every guarded endpoint answers with until setup is finished.
 *
 * A status rather than a flag in the body, because it has to work from *any* of
 * them: whichever request a half-configured session happens to make first, the
 * answer routes to the same place.
 */
export const SETUP_REQUIRED_STATUS = 428;

/**
 * Call one of this app's own JSON endpoints.
 *
 * Failures throw rather than return, because most callers are event handlers
 * that want to show the message next to the control the visitor just used.
 */
export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof (body as { error?: unknown })?.error === 'string'
        ? ((body as { error: string }).error)
        : `Request failed: ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

/**
 * Fetch the dashboard, turning every way it can fail into something sayable.
 *
 * A 401 is not an error the visitor can act on — the session simply is not
 * valid any more — so it maps to signed-out and the sign-in panel, rather than
 * to a message about a request that failed.
 */
export async function loadDashboard(): Promise<DashboardLoad> {
  try {
    return { status: 'ok', view: await apiRequest<DashboardView>('/api/me') };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return { status: 'signed-out' };
      // Not an error either: the account simply has not been set up yet, and
      // the message about a precondition is no use to someone who has not been
      // shown the pages that meet it.
      if (err.status === SETUP_REQUIRED_STATUS) return { status: 'setup' };
      return { status: 'error', message: err.message };
    }
    // Anything else is the request never completing — a dropped connection, a
    // dev server that is not running. "Failed to fetch" is not worth showing.
    return { status: 'error', message: 'Could not reach the server. Check your connection.' };
  }
}

/** The dashboard's three sections. */
export type TabId = 'classes' | 'activity' | 'settings';

const TAB_IDS: readonly TabId[] = ['classes', 'activity', 'settings'];

/**
 * Which tab to land on, read from the page's own `?tab=` query string.
 *
 * The dashboard writes this on every tab switch (see `Dashboard` in
 * app/DashboardApp.tsx) so that navigating away — to change a password, say —
 * and back returns to the tab the visitor was on, rather than always the
 * first one. Anything else, including no query string at all, falls back to
 * `classes`: that is the tab a fresh visit should open on.
 */
export function tabFromSearch(search: string): TabId {
  const value = new URLSearchParams(search).get('tab');
  return TAB_IDS.includes(value as TabId) ? (value as TabId) : 'classes';
}

export interface ScreenInput {
  /** The auth client has not yet resolved whether anyone is signed in. */
  sessionPending: boolean;
  signedIn: boolean;
  /** Null until the first dashboard request settles. */
  load: DashboardLoad | null;
}

export function dashboardScreen({ sessionPending, signedIn, load }: ScreenInput): Screen {
  if (sessionPending) return { kind: 'loading' };
  if (!signedIn) return { kind: 'signed-out' };
  if (!load) return { kind: 'loading' };

  switch (load.status) {
    case 'ok':
      return { kind: 'dashboard', view: load.view };
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'setup':
      return { kind: 'setup' };
    case 'error':
      return { kind: 'error', message: load.message };
  }
}
