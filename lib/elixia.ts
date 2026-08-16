/**
 * ██ THE ONLY FILE CONTAINING UNVERIFIED ASSUMPTIONS ██
 *
 * Every endpoint path, payload field and response shape below is a PLACEHOLDER.
 * None of it has been observed against Elixia. Discovery has not run — see
 * docs/api.md for why.
 *
 * The rest of the Worker is deliberately built so that only this file needs to
 * change once discovery is done. Fix `ENDPOINTS` and the two body-shape
 * helpers, and everything else — timing, retries, KV, notifications — keeps
 * working untouched.
 *
 * WHAT TO REPLACE, in order:
 *   1. `ENDPOINTS` — real base URL and paths.
 *   2. `authHeaders()` — real scheme (bearer? cookie? extra client headers?).
 *   3. `buildBookingBody()` / `parseLoginResponse()` — real field names.
 *   4. `classifyBookingResponse()` — real status codes and error bodies.
 *      This is the one that matters most: the retry loop cannot tell
 *      "too early, try again" from "full, give up" without it, and a loop that
 *      cannot recognise a permanent failure is exactly the unbounded hammering
 *      this project is supposed to avoid.
 *
 * Until then `assertDiscovered()` refuses to issue live requests, so a
 * misconfigured deploy fails loudly at startup instead of silently missing a
 * booking at T-0.
 */

import type { AttemptOutcome, StoredTokens, Subscription } from './types';

/**
 * What the booking engine needs from a backend.
 *
 * Declared as an interface so the mock backend (src/mock.ts) is a peer of the
 * real client rather than a special case threaded through the engine. The whole
 * app — sign-in, scheduling, cron, UI — runs end to end against either.
 */
export interface BookingBackend {
  login(email: string, password: string, nowMs: number): Promise<StoredTokens>;
  refresh(tokens: StoredTokens, nowMs: number): Promise<StoredTokens>;
  resolveClassId(
    tokens: StoredTokens,
    subscription: Subscription,
    classDate: string,
  ): Promise<string>;
  book(
    tokens: StoredTokens,
    classId: string,
    waitlist: boolean,
    signal?: AbortSignal,
  ): Promise<AttemptOutcome>;
}

/**
 * Flip to true ONLY after docs/api.md is filled in from a real capture and the
 * values below have been replaced with observed ones.
 */
export const API_DISCOVERED = false;

/** PLACEHOLDER — replace from discovery. */
export const ENDPOINTS = {
  baseUrl: 'https://api.elixia.fi',
  login: '/v1/auth/login',
  refresh: '/v1/auth/refresh',
  schedule: '/v1/schedule',
  book: '/v1/bookings',
  /** May turn out to be the same endpoint with a flag — confirm in discovery. */
  waitlist: '/v1/waitlist',
} as const;

export class DiscoveryIncompleteError extends Error {
  constructor(action: string) {
    super(
      `Refusing to ${action}: the Elixia API has not been discovered yet. ` +
        `Fill in docs/api.md from a real capture, update src/elixia.ts, then set ` +
        `API_DISCOVERED = true.`,
    );
    this.name = 'DiscoveryIncompleteError';
  }
}

function assertDiscovered(action: string): void {
  if (!API_DISCOVERED) throw new DiscoveryIncompleteError(action);
}

/** PLACEHOLDER — how auth is carried. Confirm whether a cookie is also needed. */
export function authHeaders(tokens: StoredTokens): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

/** PLACEHOLDER — the booking request body. */
export function buildBookingBody(classId: string, waitlist: boolean): string {
  return JSON.stringify(waitlist ? { classId, joinWaitlist: true } : { classId });
}

interface LoginLike {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number;
  expires_in?: number;
}

/**
 * PLACEHOLDER — maps a login/refresh response onto StoredTokens.
 *
 * Accepts both camelCase and snake_case because which one Elixia uses is
 * unknown; once discovery settles it, narrow this to the real shape rather
 * than leaving both paths live.
 */
export function parseLoginResponse(body: unknown, nowMs: number): StoredTokens {
  const b = (body ?? {}) as LoginLike;
  const accessToken = b.accessToken ?? b.access_token;
  if (!accessToken) {
    throw new Error('login response contained no access token — shape has changed');
  }
  const expiresInSec = b.expiresIn ?? b.expires_in;
  const refreshToken = b.refreshToken ?? b.refresh_token;

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    // Default conservatively: an unknown lifetime is treated as short, so the
    // Worker refreshes early rather than discovering expiry at T-0.
    expiresAtMs: nowMs + (expiresInSec ?? 300) * 1000,
    updatedAtMs: nowMs,
  };
}

/**
 * Maps an HTTP response onto a decision the retry loop can act on.
 *
 * Status codes are classified first because they are far more stable across API
 * changes than error body shapes. The body is only consulted to split apart
 * cases that share a status — typically 409/422, where "already booked" and
 * "class full" are both conflicts but need opposite handling.
 *
 * PLACEHOLDER: the body markers are guesses. The status mapping is the
 * conventional REST reading and is more likely to survive contact with reality,
 * but both must be confirmed against captured failures.
 */
export function classifyBookingResponse(
  status: number,
  bodyText: string,
  headers?: Headers,
): AttemptOutcome {
  // Error codes tend to arrive as SCREAMING_SNAKE_CASE while the markers below
  // read as English, so separators are flattened to spaces first. Without this,
  // "TOO_EARLY" matches none of them and a retryable rejection gets misread.
  const body = bodyText.toLowerCase().replace(/[_-]+/g, ' ');
  const retryAfterMs = parseRetryAfter(headers);

  if (status >= 200 && status < 300) {
    if (body.includes('waitlist') || body.includes('queue')) {
      return { kind: 'waitlisted' };
    }
    return { kind: 'booked', ...(extractBookingId(bodyText) ?? {}) };
  }

  if (status === 401 || status === 403) {
    return { kind: 'unauthorized', detail: `HTTP ${status}: ${truncate(bodyText, 300)}` };
  }

  if (status === 429) {
    return { kind: 'rate-limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  if (status === 409 || status === 422 || status === 400) {
    if (body.includes('already') || body.includes('duplicate')) return { kind: 'already-booked' };
    if (body.includes('full') || body.includes('capacity')) return { kind: 'full' };
    if (body.includes('not open') || body.includes('too early') || body.includes('not yet')) {
      return { kind: 'too-early', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { kind: 'error', detail: truncate(bodyText, 300), status };
  }

  // 404 before the window opens is plausible if unopened classes are not yet
  // addressable. Treated as retryable so a near-miss at T-0 recovers; the retry
  // budget still bounds it.
  if (status === 404) {
    return { kind: 'too-early', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  return { kind: 'error', detail: `HTTP ${status}: ${truncate(bodyText, 300)}`, status };
}

function parseRetryAfter(headers?: Headers): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  // Retry-After may also be an HTTP date.
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function extractBookingId(bodyText: string): { bookingId: string } | undefined {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const id = parsed['bookingId'] ?? parsed['id'];
    return id === undefined || id === null ? undefined : { bookingId: String(id) };
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export interface ElixiaClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Thin HTTP client. Deliberately holds no retry or timing logic — that lives in
 * booking.ts, so this file stays a pure translation layer between the Worker
 * and whatever Elixia turns out to speak.
 */
export class ElixiaClient implements BookingBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ElixiaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? ENDPOINTS.baseUrl;
  }

  /**
   * PLACEHOLDER — map a subscription to Elixia's own class id via the schedule
   * endpoint (docs/api.md §4).
   *
   * Whether an unopened class is even listed is an open question. If it is not,
   * this call has to move inside the retry loop, which lengthens the critical
   * path — worth measuring before committing to it.
   */
  async resolveClassId(
    _tokens: StoredTokens,
    _subscription: Subscription,
    _classDate: string,
  ): Promise<string> {
    assertDiscovered('resolve a class id');
    throw new Error('unreachable');
  }

  async login(email: string, password: string, nowMs: number): Promise<StoredTokens> {
    assertDiscovered('log in');
    const response = await this.fetchImpl(this.baseUrl + ENDPOINTS.login, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      throw new Error(`login failed: HTTP ${response.status}`);
    }
    return parseLoginResponse(await response.json(), nowMs);
  }

  async refresh(tokens: StoredTokens, nowMs: number): Promise<StoredTokens> {
    assertDiscovered('refresh the session');
    if (!tokens.refreshToken) {
      throw new Error('no refresh token stored — cannot refresh the session');
    }
    const response = await this.fetchImpl(this.baseUrl + ENDPOINTS.refresh, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!response.ok) {
      throw new Error(`refresh failed: HTTP ${response.status}`);
    }
    const refreshed = parseLoginResponse(await response.json(), nowMs);
    // If the response omits a new refresh token, the old one is presumed still
    // valid. Whether it actually rotates is an open question in docs/api.md §3.
    return refreshed.refreshToken
      ? refreshed
      : { ...refreshed, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
  }

  /**
   * Issue the booking (or waitlist) request and classify the result.
   *
   * The signal lets the retry loop cancel a request that outlives the budget,
   * so an abandoned attempt stops occupying a connection rather than merely
   * being ignored.
   */
  async book(
    tokens: StoredTokens,
    classId: string,
    waitlist: boolean,
    signal?: AbortSignal,
  ): Promise<AttemptOutcome> {
    assertDiscovered('book a class');
    const path = waitlist ? ENDPOINTS.waitlist : ENDPOINTS.book;
    const response = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST',
      headers: authHeaders(tokens),
      body: buildBookingBody(classId, waitlist),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text().catch(() => '');
    return classifyBookingResponse(response.status, text, response.headers);
  }
}
