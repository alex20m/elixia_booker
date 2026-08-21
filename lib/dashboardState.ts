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
  | { status: 'error'; message: string };

/** What the visitor should be looking at. */
export type Screen =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'dashboard'; view: DashboardView };

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
      return { status: 'error', message: err.message };
    }
    // Anything else is the request never completing — a dropped connection, a
    // dev server that is not running. "Failed to fetch" is not worth showing.
    return { status: 'error', message: 'Could not reach the server. Check your connection.' };
  }
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
    case 'error':
      return { kind: 'error', message: load.message };
  }
}
