/**
 * The Elixia adapter — discovered and implemented.
 *
 * Every endpoint, payload and response shape below was observed against the
 * live site in local discovery runs and is written up in docs/api.md. Nothing
 * here is a guess any more; where something is still *unconfirmed* it says so
 * at the point it matters.
 *
 * Three findings shape this file, and each removed code that used to exist:
 *
 *   1. **Auth is cookies, not a token.** Sign-in is an OAuth2 redirect chain
 *      through a SATS Group Keycloak realm and ends in four cookies. There is
 *      no bearer token and no refresh endpoint (docs/api.md §1–§3).
 *   2. **Booking never reports "full".** `POST /api/book` takes only a class
 *      id; when a class is full the *same* call places you on the waiting list
 *      and says so in the response. There is no waitlist flag, no separate
 *      waitlist endpoint, and no full-class rejection (docs/api.md §5, §6).
 *   3. **A class is not addressable before its booking window opens.** It is
 *      simply absent from the schedule until then, so "too early" surfaces as
 *      *resolution failing*, not as a booking error (docs/api.md §4). That is
 *      why `resolveClassId` throws `ClassNotListedError` rather than returning
 *      something the booking call would choke on.
 */

import { ClassNotListedError, UnknownCenterError, WEEKDAYS } from './types';
import type {
  AttemptOutcome,
  CenterOption,
  ClassOption,
  StoredTokens,
  Subscription,
  Weekday,
} from './types';

// Defined in types.ts, not here, so booking.ts can branch on it without
// depending on the adapter. Re-exported because this is the file whose
// functions throw it.
export { ClassNotListedError, UnknownCenterError };

/**
 * What the booking engine needs from a backend.
 *
 * Declared as an interface so the mock backend (lib/mock.ts) is a peer of the
 * real client rather than a special case threaded through the engine. The whole
 * app — sign-in, scheduling, cron, UI — runs end to end against either.
 */
export interface BookingBackend {
  login(email: string, password: string, nowMs: number): Promise<StoredTokens>;
  refresh(tokens: StoredTokens, nowMs: number): Promise<StoredTokens>;
  /** Every centre this account can browse — the chooser's centre list. */
  listCenters(tokens: StoredTokens): Promise<CenterOption[]>;
  /** The weekly classes published for one centre — the chooser's class list. */
  listClasses(tokens: StoredTokens, center: string): Promise<ClassOption[]>;
  resolveClassId(
    tokens: StoredTokens,
    subscription: Subscription,
    classDate: string,
  ): Promise<string>;
  book(tokens: StoredTokens, classId: string, signal?: AbortSignal): Promise<AttemptOutcome>;
}

/**
 * Discovery is complete: the adapter speaks the real API.
 *
 * Kept as an exported constant because the dashboard and /api/health surface
 * it, and because flipping it back is the honest way to disable live calls if
 * Elixia's flow is ever found to have changed underneath us.
 */
export const API_DISCOVERED = true;

/** Real, observed endpoints (docs/api.md §1, §4, §5). */
export const ENDPOINTS = {
  baseUrl: 'https://www.elixia.fi',
  /** Start of the login redirect chain; carries `onSuccess` as the post-login path. */
  loginStart: '/kirjaudu-sisaan',
  /** Server-rendered schedule page. Its embedded JSON is the listing API — see §4. */
  schedule: '/varaukset',
  book: '/api/book',
  /** Not used by the booking engine, but confirmed working — see docs/api.md §5. */
  unbook: '/api/unbook',
} as const;

/**
 * Auth on every request (docs/api.md §2): cookies only — no Authorization
 * header, no bearer token. The session is too large for one cookie, so it
 * arrives as `.SATS_GROUP_AUTH` plus three numbered continuations;
 * `tokens.accessToken` holds all four, already serialized as a `Cookie:`
 * header value (see `jarHeader`).
 *
 * `origin`/`referer` are sent because the browser sent them and they cost
 * nothing, not because they are confirmed load-bearing — the minimal required
 * header set (docs/api.md §2's "test to run") is still unverified.
 */
export function authHeaders(tokens: StoredTokens): Record<string, string> {
  return {
    cookie: tokens.accessToken,
    accept: 'application/json',
    'content-type': 'application/json',
    origin: ENDPOINTS.baseUrl,
    referer: `${ENDPOINTS.baseUrl}${ENDPOINTS.schedule}`,
  };
}

/**
 * The booking body is just the class id (docs/api.md §5). There is deliberately
 * no waitlist parameter: the server decides between booking and waitlisting on
 * its own, and both are success as far as this app is concerned.
 */
export function buildBookingBody(classId: string): string {
  return JSON.stringify({ id: classId });
}

// --- the login flow ----------------------------------------------------------
//
// www.elixia.fi delegates sign-in to a Keycloak realm at auth.satsgroup.com via
// a standard OAuth2 authorization-code redirect: no PKCE on this client, and no
// CSRF token beyond the `session_code`/`execution` values Keycloak bakes into
// the login form's own POST target. Every hop is a plain GET/POST plus a 30x
// redirect — no JavaScript runs anywhere in the chain, so it replays outside a
// browser with nothing more than a cookie jar. No CAPTCHA or JS challenge was
// present on the form in the captured runs (docs/api.md §7); that is two data
// points, not a guarantee, and 2FA in particular was never exercised (§1).
//
// There is no JSON token response anywhere in the chain — the session lives
// entirely in the cookies described above.

const SESSION_COOKIE_NAME = '.SATS_GROUP_AUTH';
/** Observed `Max-Age` on `.SATS_GROUP_AUTH` (docs/api.md §1): 14 days. */
const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 10;

function jarHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Folds every `Set-Cookie` on a response into the jar, and updates `ttl` if
 * this response is the one that sets the session cookie's `Max-Age`.
 *
 * Requires `Headers#getSetCookie` (Node 18.14+ / any Vercel Node runtime) —
 * `Headers#get('set-cookie')` collapses multiple cookies into one
 * comma-joined string that cannot be split back apart safely, since a
 * `Max-Age`/`Expires` value can itself contain a comma.
 */
function absorbSetCookies(headers: Headers, jar: Map<string, string>, ttl: { ms: number }): void {
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    jar.set(name, pair.slice(eq + 1).trim());

    if (name === SESSION_COOKIE_NAME) {
      const maxAge = /max-age=(\d+)/i.exec(line);
      if (maxAge) ttl.ms = Number(maxAge[1]) * 1000;
    }
  }
}

/**
 * Issues one request and follows any 30x `Location` chain that results,
 * carrying `jar` across every hop, until a non-redirect response comes back.
 *
 * Node's `fetch` (undici) — unlike a spec-strict browser fetch — does not
 * opaque-filter a `redirect: 'manual'` response, so `status`, `location` and
 * `set-cookie` all stay readable; that is what makes walking the chain by
 * hand possible at all. Only the first hop keeps the caller's method/body —
 * every hop after a redirect is a plain GET, matching what every redirect in
 * the captured chain actually did.
 */
async function fetchFollowing(
  fetchImpl: typeof fetch,
  jar: Map<string, string>,
  ttl: { ms: number },
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let currentUrl = url;
  let currentInit: RequestInit = init;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = new Headers(currentInit.headers);
    const cookie = jarHeader(jar);
    if (cookie) headers.set('cookie', cookie);

    const response = await fetchImpl(currentUrl, { ...currentInit, headers, redirect: 'manual' });
    absorbSetCookies(response.headers, jar, ttl);

    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;

    currentUrl = new URL(location, currentUrl).toString();
    currentInit = {};
  }

  throw new Error(
    'Elixia login: too many redirects while chasing the auth flow — see docs/api.md §1',
  );
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Pulls the login form's `action` URL out of the Keycloak page. Every value
 * the form needs to submit (`session_code`, `execution`, `client_id`,
 * `tab_id`, `client_data`) is baked into that one URL — there are no separate
 * hidden fields to read.
 */
function extractLoginFormAction(html: string): string | null {
  const match = /<form\b[^>]*\baction="([^"]+)"[^>]*\bmethod="post"/i.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]) : null;
}

/**
 * Real login flow (docs/api.md §1). See the section comment above for the
 * mechanics; this is the orchestration.
 */
export async function performElixiaLogin(
  fetchImpl: typeof fetch,
  baseUrl: string,
  email: string,
  password: string,
  nowMs: number,
): Promise<StoredTokens> {
  const jar = new Map<string, string>();
  const ttl = { ms: DEFAULT_SESSION_TTL_MS };

  const loginPage = await fetchFollowing(
    fetchImpl,
    jar,
    ttl,
    `${baseUrl}${ENDPOINTS.loginStart}?onSuccess=%2Fomat-sivut`,
  );
  const html = await loginPage.text();
  const action = extractLoginFormAction(html);
  if (!action) {
    throw new Error(
      'Elixia login: could not find the Keycloak sign-in form — the flow has changed, see docs/api.md §1',
    );
  }

  await fetchFollowing(fetchImpl, jar, ttl, action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password, credentialId: '' }).toString(),
  });

  // A wrong password does not come back as an error status — Keycloak
  // re-renders the same login form (HTTP 200, no redirect) instead. So
  // "the session cookie never showed up" is the actual failure signal here,
  // not any particular status code.
  if (!jar.has(SESSION_COOKIE_NAME)) {
    throw new Error('Elixia rejected the email or password');
  }

  return {
    accessToken: jarHeader(jar),
    expiresAtMs: nowMs + ttl.ms,
    updatedAtMs: nowMs,
  };
}

// --- the schedule listing ----------------------------------------------------
//
// There is no JSON schedule API. `/varaukset` is a server-rendered page, and
// every filter change is a full navigation rather than a fetch. The data is
// nonetheless structured: the page embeds its entire props object in a single
// `<script data-props="true" type="application/json">` tag, and that object
// holds both the club list and the classes. Parsing that tag is the listing
// API (docs/api.md §4).
//
// Two properties of the page drive the code below:
//
//   * **`clubIds` is mandatory.** Requested without it, the page renders an
//     "apply filters" prompt and carries no `schedule.events` at all — so a
//     centre has to be resolved to a numeric club id before anything can be
//     looked up.
//   * **Only bookable dates carry events.** `schedule.dateList.dates` marks
//     every date beyond the booking window `disabled: true`, and those dates
//     have zero events. A class further out than the window is therefore not
//     merely unbookable but *invisible*, which is what `ClassNotListedError`
//     represents.

const DATA_PROPS_RE = /<script data-props="true" type="application\/json">([\s\S]*?)<\/script>/;

export interface ScheduleEvent {
  id: string;
  isBooked: boolean;
  hasWaitingList: boolean;
  waitingListCount: number;
  metadata: {
    name: string;
    clubName: string;
    /** Offset-bearing ISO 8601, e.g. "2026-08-21T17:00:00+03:00". */
    startsAt: string;
    /** Local start time as displayed, "HH:MM". */
    time: string;
    duration: number;
  };
}

export interface ScheduleDay {
  date: string;
  events: ScheduleEvent[];
}

export interface SchedulePageProps {
  filters?: unknown;
  schedule?: {
    events?: ScheduleDay[];
    dateList?: { dates?: Array<{ isoDate?: string; disabled?: boolean }> };
    hasResults?: boolean;
  };
}

/** Reads the page's embedded props object. Throws if the page is not one. */
export function extractDataProps(html: string): SchedulePageProps {
  const match = DATA_PROPS_RE.exec(html);
  if (!match?.[1]) {
    throw new Error(
      'Elixia schedule: no data-props script found — the page shape has changed, see docs/api.md §4',
    );
  }
  return JSON.parse(match[1]) as SchedulePageProps;
}

/**
 * Every centre the schedule page's own filter offers (226 clubs across the
 * group in the observed capture).
 *
 * Walks the filter tree rather than indexing a fixed path: the filters object
 * is deeply nested presentation data whose shape is far more likely to be
 * rearranged than the `{queryName: 'clubIds', options: [{value, label}]}`
 * node itself.
 *
 * **Every such node, not the first.** The page splits its clubs across
 * several `clubIds` nodes — `categories` is an array — so stopping at the
 * first match returns one group and silently drops the rest. That is not a
 * cosmetic loss: this is also how a stored centre name is resolved to its
 * club id, so a club in a later group stops resolving and its subscription
 * books nothing, in exactly the way an unopened class does. Ids repeat across
 * groups where a club is served by more than one filter, so the first
 * spelling of each wins and the rest collapse.
 *
 * **A flat list on purpose**, and not for want of trying: a version of this
 * read the titles the `clubIds` nodes sit under and offered country → city →
 * club, which is how a list this long ought to be navigated. Against the live
 * page it collapsed to one country, one city and every club — the tree has no
 * location titles to read, and there is no other field carrying a club's
 * place (docs/api.md §4). Grouping needs a source of geography that does not
 * exist here yet, so the list is flat and the chooser remembers the last
 * centre instead.
 *
 * Sorted by name because the merged order is otherwise an artefact of how the
 * page happens to nest its filters, and a list this long is only navigable in
 * a predictable one. An absent or restyled tree yields an empty list rather
 * than throwing — the caller says what a missing centre list means, and for
 * the chooser that is "nothing to offer", not a crash.
 */
export function listClubOptions(props: SchedulePageProps): CenterOption[] {
  const byId = new Map<string, CenterOption>();

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record['queryName'] === 'clubIds' && Array.isArray(record['options'])) {
      for (const option of record['options'] as Array<Record<string, unknown>>) {
        const id = typeof option['value'] === 'string' ? option['value'] : '';
        const name = typeof option['label'] === 'string' ? option['label'].trim() : '';
        if (id && name && !byId.has(id)) byId.set(id, { id, name });
      }
    }
    for (const value of Object.values(record)) walk(value);
  };

  walk(props.filters ?? props);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a club's numeric id by its display name.
 *
 * Case- and space-insensitive because the name may have been typed by hand:
 * subscriptions created before the chooser existed still carry whatever their
 * owner wrote.
 */
export function findClubIdByName(props: SchedulePageProps, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  return listClubOptions(props).find((club) => club.name.toLowerCase() === wanted)?.id ?? null;
}

/** "9:00" and "09:00" are the same time; the page renders the padded form. */
export function normalizeTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return value.trim();
  return `${match[1]!.padStart(2, '0')}:${match[2]}`;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The weekday a published date falls on.
 *
 * Read from the date string in UTC rather than from `metadata.startsAt`: the
 * date group is already the local calendar day Elixia filed the class under,
 * so parsing it in any other zone can shift it across midnight and file a
 * Friday evening class under Saturday. Returns null for anything that is not
 * a plain `YYYY-MM-DD`, so a restyled page drops the day instead of inventing
 * one.
 */
export function weekdayOfIsoDate(isoDate: string): Weekday | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const at = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(at) ? null : (WEEKDAYS[new Date(at).getUTCDay()] ?? null);
}

/** Monday first: a timetable is read as a week, not from Sunday. */
const WEEK_ORDER: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/**
 * Every distinct weekly slot the published schedule contains.
 *
 * The listing spans ~14 days, so a weekly class appears in it twice; the
 * chooser wants one row per slot, which is why identical name/weekday/time
 * triples collapse. That triple is exactly what `findClassId` matches on
 * later, so anything this returns is resolvable on the day — and anything it
 * omits is not merely unlisted but unbookable by this app, since the booking
 * engine reads the same embedded props.
 */
export function collectClassOptions(props: SchedulePageProps): ClassOption[] {
  const seen = new Map<string, ClassOption>();

  for (const day of props.schedule?.events ?? []) {
    const weekday = weekdayOfIsoDate(day.date ?? '');
    if (!weekday) continue;

    for (const event of day.events ?? []) {
      const className = (event.metadata?.name ?? '').trim();
      const startTime = normalizeTime(event.metadata?.time ?? '');
      if (!className || !/^\d{2}:\d{2}$/.test(startTime)) continue;

      const key = `${normalizeName(className)}|${weekday}|${startTime}`;
      if (!seen.has(key)) seen.set(key, { className, weekday, startTime });
    }
  }

  return [...seen.values()].sort(
    (a, b) =>
      WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) ||
      a.startTime.localeCompare(b.startTime) ||
      a.className.localeCompare(b.className),
  );
}

/**
 * Picks the class matching a subscription out of a parsed schedule page.
 *
 * Matched on date + start time + class name, because that triple is what the
 * user actually chose and what stays stable week to week. The class *id* does
 * not: ids differ between occurrences of the same weekly class (observed
 * `741p70111` and `741p70095` for the same class on different days), so an id
 * can only ever be resolved for one concrete date.
 */
export function findClassId(
  props: SchedulePageProps,
  subscription: Pick<Subscription, 'className' | 'startTime'>,
  classDate: string,
): string {
  // This check comes first because a date beyond the published range is still
  // *present* in both the picker and the events array — just marked disabled
  // and carrying zero classes. Diagnosing that as "the class is not listed"
  // would be technically true and completely unhelpful.
  //
  // Note what `disabled` does *not* mean: it is not your booking window. Elixia
  // publishes the same ~14 days to everyone, while how far ahead you may book
  // is a membership tier (docs/api.md §4). A date can be enabled and listed and
  // still be unbookable by you — so this says "published", not "bookable".
  const known = (props.schedule?.dateList?.dates ?? []).find((d) => d.isoDate === classDate);
  if (known?.disabled === true) {
    throw new ClassNotListedError(
      `No classes listed for ${classDate} — that date is beyond the published schedule.`,
    );
  }

  const day = (props.schedule?.events ?? []).find((d) => d.date === classDate);
  if (!day) {
    throw new ClassNotListedError(
      `No classes listed for ${classDate} — that date is not in the schedule at all.`,
    );
  }

  const wantedName = normalizeName(subscription.className);
  const wantedTime = normalizeTime(subscription.startTime);

  const match = day.events.find(
    (e) =>
      normalizeName(e.metadata?.name ?? '') === wantedName &&
      normalizeTime(e.metadata?.time ?? '') === wantedTime,
  );

  if (!match) {
    throw new ClassNotListedError(
      `"${subscription.className}" at ${wantedTime} is not listed on ${classDate} ` +
        `(${day.events.length} other classes are). Either booking has not opened, or the ` +
        `class name or time no longer matches the schedule.`,
    );
  }

  return match.id;
}

// --- booking responses -------------------------------------------------------

/**
 * Maps an HTTP response onto a decision the retry loop can act on.
 *
 * **Classification is by status code, never by message text.** The page embeds
 * the exact error taxonomy the booking endpoint uses — `badRequest`,
 * `conflict`, `forbidden`, `unauthorized`, `unknown`, `unknownDownstream` —
 * and every message in it is localized Finnish (the observed 409 body was
 * `{"message":"Sinulla on voimassa oleva varaus päällekkäin."}`). Matching
 * English substrings, as this function used to, would have classified every
 * real failure as an unrecognised error.
 *
 * Note what the taxonomy does *not* contain: there is no "class full" and no
 * "too early". Those are not error cases at all — a full class returns 200
 * with `OnWaitingList`, and an unopened one is absent from the schedule, so it
 * fails at resolution instead (see `ClassNotListedError`).
 */
export function classifyBookingResponse(
  status: number,
  bodyText: string,
  headers?: Headers,
): AttemptOutcome {
  if (status >= 200 && status < 300) return classifyBookingSuccess(bodyText);

  const retryAfterMs = parseRetryAfter(headers);
  const message = extractServerMessage(bodyText);
  const detail = message ?? `HTTP ${status}: ${truncate(bodyText, 300)}`;

  switch (status) {
    // "You must sign in to make a booking" — the session has lapsed.
    case 401:
      return { kind: 'unauthorized', detail };
    // "Booking has been blocked." A membership problem, not an expired
    // session: permanent, and no amount of re-authenticating fixes it. It
    // shares the non-retryable `unauthorized` outcome because that is the only
    // one with the right retry semantics, and the server's own message is
    // carried through so the notification says which of the two it was.
    case 403:
      return { kind: 'unauthorized', detail };
    // "You have an overlapping reservation." Covers both booking the same
    // class twice and holding a different class at the same time — the API
    // does not distinguish them, so neither can this. Permanent either way.
    case 409:
      return { kind: 'already-booked', detail };
    case 429:
      return { kind: 'rate-limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    // Not part of the documented taxonomy. Treated as retryable on the theory
    // that a class id can briefly 404 around the moment it becomes bookable;
    // the retry budget bounds it either way.
    case 404:
      return { kind: 'too-early', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    default:
      return { kind: 'error', detail, status };
  }
}

interface BookingSuccessBody {
  payload?: {
    status?: string;
    participationId?: string;
    waitingListPosition?: number;
  };
}

/**
 * A 2xx always carries `payload.status`, which is `"Booked"` or
 * `"OnWaitingList"` (docs/api.md §5, §6). Both are success: the app books
 * whatever it can get, and a waiting-list place is a place.
 */
function classifyBookingSuccess(bodyText: string): AttemptOutcome {
  let parsed: BookingSuccessBody;
  try {
    parsed = JSON.parse(bodyText) as BookingSuccessBody;
  } catch {
    return {
      kind: 'error',
      detail: `2xx response was not the expected JSON shape: ${truncate(bodyText, 300)}`,
      status: 200,
    };
  }

  const payload = parsed.payload;
  if (payload?.status === 'Booked') {
    return {
      kind: 'booked',
      ...(payload.participationId ? { bookingId: payload.participationId } : {}),
    };
  }
  if (payload?.status === 'OnWaitingList') {
    return {
      kind: 'waitlisted',
      ...(payload.participationId ? { bookingId: payload.participationId } : {}),
      ...(typeof payload.waitingListPosition === 'number'
        ? { position: payload.waitingListPosition }
        : {}),
    };
  }

  return {
    kind: 'error',
    detail: `unrecognised booking status in a 2xx response: ${truncate(bodyText, 300)}`,
    status: 200,
  };
}

/** Errors come back as `{"message": "<localized text>"}`. */
function extractServerMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown };
    return typeof parsed.message === 'string' && parsed.message
      ? truncate(parsed.message, 300)
      : undefined;
  } catch {
    return undefined;
  }
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export interface ElixiaClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Thin HTTP client. Deliberately holds no retry or timing logic — that lives in
 * booking.ts, so this file stays a pure translation layer between the app and
 * what Elixia speaks.
 */
export class ElixiaClient implements BookingBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ElixiaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? ENDPOINTS.baseUrl;
  }

  private async fetchPage(tokens: StoredTokens, url: string): Promise<SchedulePageProps> {
    const response = await this.fetchImpl(url, {
      headers: {
        cookie: tokens.accessToken,
        accept: 'text/html',
        referer: `${this.baseUrl}${ENDPOINTS.schedule}`,
      },
      // Explicit rather than relying on the framework's current default. Every
      // reader of this page wants *now*: the chooser would otherwise offer a
      // stale timetable, and the booking engine reads the same page at T-0 to
      // find a class that appears only at the instant its window opens — a
      // cached copy there would miss the booking entirely.
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Elixia schedule: HTTP ${response.status} fetching ${url}`);
    }
    return extractDataProps(await response.text());
  }

  /**
   * A centre may be stored either as the numeric club id the API uses, or as
   * the name a human recognises. A name costs one extra request — the club
   * list only exists on the schedule page — which is why the booking engine
   * resolves the class id ahead of T-0 wherever it can.
   */
  private async resolveClubId(tokens: StoredTokens, center: string): Promise<string> {
    const trimmed = center.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;

    const props = await this.fetchPage(tokens, `${this.baseUrl}${ENDPOINTS.schedule}`);
    const id = findClubIdByName(props, trimmed);
    if (!id) throw new UnknownCenterError(center);
    return id;
  }

  /**
   * The centre list, which only the schedule page carries.
   *
   * Deliberately the unfiltered page: it costs no club id to fetch and its
   * filter tree holds every club in the group, which is exactly the list a
   * chooser has to offer before the user has picked anything.
   */
  async listCenters(tokens: StoredTokens): Promise<CenterOption[]> {
    return listClubOptions(await this.fetchPage(tokens, `${this.baseUrl}${ENDPOINTS.schedule}`));
  }

  /**
   * Every weekly slot published for one centre.
   *
   * Same request `resolveClassId` makes at T-0, read for its whole timetable
   * rather than for one class — so what the chooser offers and what booking
   * can resolve come from a single source, and cannot disagree.
   */
  async listClasses(tokens: StoredTokens, center: string): Promise<ClassOption[]> {
    const clubId = await this.resolveClubId(tokens, center);
    const url = `${this.baseUrl}${ENDPOINTS.schedule}?clubIds=${encodeURIComponent(clubId)}`;
    return collectClassOptions(await this.fetchPage(tokens, url));
  }

  async resolveClassId(
    tokens: StoredTokens,
    subscription: Subscription,
    classDate: string,
  ): Promise<string> {
    const clubId = await this.resolveClubId(tokens, subscription.center);
    const url = `${this.baseUrl}${ENDPOINTS.schedule}?clubIds=${encodeURIComponent(clubId)}`;
    return findClassId(await this.fetchPage(tokens, url), subscription, classDate);
  }

  async login(email: string, password: string, nowMs: number): Promise<StoredTokens> {
    return performElixiaLogin(this.fetchImpl, this.baseUrl, email, password, nowMs);
  }

  /**
   * No refresh endpoint exists (docs/api.md §3: "none observed") — the session
   * is a 14-day cookie, renewed only by logging in again. `login` accordingly
   * never sets `tokens.refreshToken`, so service.ts's own fallback ("no
   * refresh token → log in with the stored password") means this is never
   * reached. It exists to satisfy `BookingBackend`, and throws rather than
   * pretending to have refreshed anything.
   */
  async refresh(_tokens: StoredTokens, _nowMs: number): Promise<StoredTokens> {
    throw new Error(
      'Elixia has no token-refresh endpoint (docs/api.md §3) — sessions are renewed by ' +
        'logging in again, not by refreshing.',
    );
  }

  /**
   * Issue the booking request and classify the result.
   *
   * The signal lets the retry loop cancel a request that outlives the budget,
   * so an abandoned attempt stops occupying a connection rather than merely
   * being ignored.
   */
  async book(
    tokens: StoredTokens,
    classId: string,
    signal?: AbortSignal,
  ): Promise<AttemptOutcome> {
    const response = await this.fetchImpl(this.baseUrl + ENDPOINTS.book, {
      method: 'POST',
      headers: authHeaders(tokens),
      body: buildBookingBody(classId),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text().catch(() => '');
    return classifyBookingResponse(response.status, text, response.headers);
  }
}
