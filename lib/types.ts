/** Shared types for the booking Worker. */

export type Weekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

export const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * A centre, as Elixia's own schedule filter lists it.
 *
 * Both halves are used: the id is what the schedule page filters on, the name
 * is what a person recognises and what a subscription stores. There is no
 * country or city here because the page carries neither — see
 * `listClubOptions`, which tried.
 */
export interface CenterOption {
  id: string;
  name: string;
}

/**
 * One weekly slot that actually exists on the published schedule.
 *
 * This is the unit the chooser offers and a subscription is built from — the
 * triple `findClassId` matches on, minus the date, because a subscription
 * recurs and a listed occurrence does not.
 */
export interface ClassOption {
  className: string;
  weekday: Weekday;
  startTime: string;
  /** Who is running the soonest published occurrence, if the listing says. */
  instructorName?: string;
}

/** One class you want booked, every week. */
export interface DesiredClass {
  /** Stable local identifier, used in logs and notifications. */
  id: string;
  /** Centre: either Elixia's numeric club id, or the club's exact name. */
  center: string;
  /** Class name as it appears on the schedule, e.g. "Bodypump". */
  className: string;
  weekday: Weekday;
  /** Local start time, 24h "HH:MM" in the club's timezone. */
  startTime: string;
  /** Lower number wins when two releases land in the same run. */
  priority: number;
  /** Overrides the global window. 7 = Basic/Flexible, 14 = Premium. */
  bookingWindowDays?: number;
  /** Set false to keep the entry but stop acting on it. */
  enabled?: boolean;
}

export interface BookingConfig {
  /** IANA zone the schedule is published in. */
  timeZone: string;
  /** Default booking window when a class does not override it. */
  bookingWindowDays: number;
  /** Classes to book. */
  classes: DesiredClass[];
  /**
   * Fire the request this many ms before the computed release instant, to
   * absorb network latency. Keep small — too eager and the server rejects the
   * attempt as early. 0 means fire exactly at T-0.
   */
  leadMs: number;
  /** Total wall-clock budget for the retry loop, in ms. */
  retryBudgetMs: number;
  /** Delay before the first retry; grows exponentially from here. */
  retryBaseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  retryMaxDelayMs: number;
  /**
   * How far ahead of a release instant the cron handler will claim it.
   * Must comfortably exceed the cron interval, or a release can fall between
   * two runs and never be claimed.
   */
  claimHorizonMs: number;
  /**
   * How late a release may be claimed. Cloudflare cron firing is not precise;
   * without a grace window a run that starts a few seconds late would skip the
   * slot entirely rather than trying immediately.
   */
  claimGraceMs: number;
}

/** A class occurrence resolved to concrete instants. */
export interface PlannedBooking {
  desired: DesiredClass;
  /** When booking opens, epoch ms UTC. */
  releaseEpochMs: number;
  /** When the class starts, epoch ms UTC. */
  classEpochMs: number;
  /** Local date of the class, "YYYY-MM-DD". */
  classDate: string;
  /** Set when the release fell on a DST edge — worth surfacing in logs. */
  releaseNote?: 'gap' | 'ambiguous';
}

/**
 * The class is not on the schedule for that date.
 *
 * Its own type because it is the *expected* state before a booking window
 * opens — Elixia does not list a class at all until it becomes bookable
 * (docs/api.md §4) — and so has to be told apart from a real failure to look
 * it up, such as an unknown centre or a changed page. One is worth waiting
 * through; the other never resolves no matter how long you retry.
 */
export class ClassNotListedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassNotListedError';
  }
}

/**
 * Elixia said no to this email and password.
 *
 * Its own type because it is the one login failure that is the *user's* to
 * fix. Everything else that can go wrong in the sign-in chain — the site being
 * unreachable, the Keycloak form having changed shape, a redirect loop — says
 * nothing about whether the credentials are good, and telling someone their
 * password is wrong during an outage sends them hunting for a typo that is not
 * there. The two have to be told apart at the point they are raised, because
 * by the time they reach the browser they are both just "login failed".
 */
export class ElixiaCredentialsRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElixiaCredentialsRejected';
  }
}

/**
 * The centre is not one Elixia has.
 *
 * Told apart from a listing that came back empty, because the two look
 * identical from the outside and mean opposite things: an unknown centre is
 * the caller's mistake and never resolves, while an empty timetable is a real
 * answer about a real club.
 */
export class UnknownCenterError extends Error {
  constructor(readonly center: string) {
    super(
      `No Elixia centre named "${center}". Pick one from the list, or use its numeric club id.`,
    );
    this.name = 'UnknownCenterError';
  }
}

/**
 * Where one specific class occurrence stands on Elixia's published schedule
 * right now, without treating absence as an error.
 *
 * - `available`     — listed on that date; bookable once its window opens.
 * - `unavailable`   — that date is published (other classes are listed on
 *                      it) and this one simply is not among them. A real
 *                      absence — a one-off cancellation, most likely, since
 *                      some Elixia classes run that way — not "too early".
 * - `not-published` — that date is not published yet at all (or is marked
 *                      disabled), so nothing can be concluded either way —
 *                      the same state `ClassNotListedError` represents
 *                      before a booking window opens (docs/api.md §4).
 */
export type ClassAvailabilityStatus = 'available' | 'unavailable' | 'not-published';

/**
 * Whether the signed-in user still holds a specific class occurrence, read
 * from the same per-user flag the schedule page carries (`ScheduleEvent.isBooked`).
 *
 * - `booked`     — still held. The common case for anything this app booked.
 * - `not-booked` — the occurrence is listed, and the user is not on it. The
 *                   class was cancelled through Elixia's own app or site —
 *                   this app never calls its own unbook endpoint — so a
 *                   calendar entry for it should stop being served.
 * - `unknown`    — the date could not be read at all (not published, or the
 *                   centre could not be reached). Never treated as
 *                   `not-booked`: a page that could not be read says nothing
 *                   about whether a booking still holds, and reading that as
 *                   a cancellation would drop calendar entries on an outage.
 */
export type ClassBookedStatus = 'booked' | 'not-booked' | 'unknown';

/**
 * Outcome of a single booking attempt.
 *
 * There is deliberately no `full`: Elixia never rejects a booking for being
 * full — it places you on the waiting list and returns success (docs/api.md
 * §6). A full class is therefore `waitlisted`, not a failure.
 */
export type AttemptOutcome =
  | { kind: 'booked'; bookingId?: string }
  | { kind: 'waitlisted'; position?: number; bookingId?: string }
  | { kind: 'already-booked'; detail?: string }
  | { kind: 'too-early'; retryAfterMs?: number }
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'unauthorized'; detail: string }
  | { kind: 'error'; detail: string; status?: number };

/** Whether an outcome is worth retrying, or is final. */
export function isRetryable(outcome: AttemptOutcome): boolean {
  switch (outcome.kind) {
    // 'too-early' is the class not being listed yet, which is exactly the
    // state a run started just before T-0 expects to sit through.
    case 'too-early':
    case 'rate-limited':
    case 'error':
      return true;
    // An overlapping booking and a rejected session will not fix themselves
    // inside our budget. Retrying either is pure hammering.
    case 'booked':
    case 'waitlisted':
    case 'already-booked':
    case 'unauthorized':
      return false;
  }
}

/** Tokens as persisted in KV. */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAtMs: number;
  /** Epoch ms this record was written, for debugging staleness. */
  updatedAtMs: number;
}

/**
 * What actually gets sealed into UserRecord.sessionBlob.
 *
 * The email lives in here rather than as a plaintext field so the UI can show
 * a user which account they are signed in as, without KV ever holding an
 * address that would enumerate a gym's membership if the namespace leaked.
 */
export interface SealedSession {
  tokens: StoredTokens;
  email: string;
}

// --- Application model -------------------------------------------------------

/**
 * What gets sealed into Profile.elixiaSecret.
 *
 * The Elixia password is kept, encrypted, because the bot has to run unattended
 * for weeks: when a session finally expires, re-authenticating is the only way
 * to carry on without emailing the user to come and re-link. That is a real
 * trade-off, not a convenience — so it is disclosed in the UI, the blob is
 * sealed under a key that never touches the database, and removing it is one
 * click.
 */
export interface SealedElixiaSecret {
  password: string;
  tokens?: StoredTokens;
}

/** Whether a user's Elixia account is usable right now. */
export type ElixiaStatus = 'unlinked' | 'ok' | 'expired';

/**
 * Where a user's booking alerts go.
 *
 * Every one of these has to be chosen: `email` needs an address confirmed even
 * though the session carries one, `telegram` needs a chat connected first, and
 * `none` is a real choice rather than an absence — someone who never wants to
 * hear from the bot should be able to say so, and be told plainly that the
 * "booking has stopped" alert goes nowhere either.
 */
export type NotifyChannel = 'email' | 'telegram' | 'none';

/**
 * One account, keyed by the Neon Auth user id.
 *
 * Three fields below are optional in the type and mandatory in practice, and
 * that gap is the whole point: this app ships no defaults for them, so a
 * profile exists in an unconfigured state from signup until the setup pages
 * are finished. `isConfigured` is the only way past it, and everything that
 * would act on a profile — the dashboard, the planner, the cron — goes through
 * that narrowing rather than reading the fields hopefully.
 */
export interface Profile {
  id: string;
  /** How far ahead this membership may book. Absent until setup. */
  bookingWindowDays?: number;
  /** The zone class times are read in. Absent until setup — never guessed. */
  timeZone?: string;
  /** Where alerts go. Absent until setup; there is no fallback channel. */
  notifyChannel?: NotifyChannel;
  /**
   * Where `email` notifications go. Suggested from the Neon Auth session
   * during setup and stored only once confirmed — the gym account, the login
   * and the inbox that should receive alerts are not always the same address.
   */
  notifyEmail?: string;
  /**
   * The user's own Telegram chat, learned from the connect flow rather than
   * typed in — see lib/telegramLink.ts for why that distinction matters.
   */
  telegramChatId?: string;
  /** Shown in the UI so the user can see which gym account is linked. */
  elixiaEmail?: string;
  /** AES-256-GCM sealed SealedElixiaSecret. Absent when unlinked. */
  elixiaSecret?: string;
  elixiaStatus: ElixiaStatus;
  elixiaCheckedAtMs?: number;
  /**
   * The centre this user last chose a class from, as Elixia's club id.
   *
   * Remembered because it does not change: someone books at their own gym,
   * week after week, and finding it again in a list of 226 is a chore before
   * the choice that matters. Only the centre is kept — the class itself is
   * the decision being made, so it is never prefilled.
   *
   * Absent until a first choice is made, and ignored if the club it names has
   * since disappeared from the filter: a stale default selects nothing rather
   * than the wrong thing.
   */
  defaultCenter?: string;
  /**
   * When the setup pages were finished. Absent until they are.
   *
   * Kept as its own field rather than inferred from the three settings being
   * present, because inference cannot tell a value someone chose from a value
   * that happened to be there — which is exactly what profiles written before
   * setup existed are full of. Those get asked once, and keep their answers.
   */
  configuredAtMs?: number;
  /**
   * Whether booked classes are published to the calendar feed.
   *
   * Kept apart from `calendarFeedToken` being present: turning sync off must
   * stop the feed from serving anything without throwing away the token, so a
   * user who turns it back on later gets the same subscription URL back
   * rather than having to re-add a new one in their calendar app.
   */
  calendarSyncEnabled?: boolean;
  /**
   * The secret that names this user's calendar feed (`/api/calendar/<token>`).
   *
   * Minted once, on first enabling sync, and kept from then on — including
   * across a later disable/re-enable — so the URL a user pasted into their
   * calendar app keeps working. Rotate it (a fresh token) only when the old
   * one may have leaked; there is no other reason to change it.
   */
  calendarFeedToken?: string;
}

/**
 * A profile whose owner has been through setup.
 *
 * Everything that turns a class into an instant, or an outcome into a message,
 * needs all of these — so they are demanded once, at the boundary, instead of
 * being defaulted at each of the dozen places that read them.
 */
export type ConfiguredProfile = Profile & {
  bookingWindowDays: number;
  timeZone: string;
  notifyChannel: NotifyChannel;
  configuredAtMs: number;
};

/**
 * Whether this profile is ready to be acted on.
 *
 * Deliberately does *not* require the chosen channel's destination to still be
 * present. Disconnecting Telegram leaves someone with a channel and nowhere to
 * send, which must show up as a warning on the dashboard — not as an account
 * that has stopped booking, which is what sending them back through setup
 * would amount to.
 */
export function isConfigured(profile: Profile): profile is ConfiguredProfile {
  return (
    profile.configuredAtMs !== undefined &&
    profile.bookingWindowDays !== undefined &&
    profile.timeZone !== undefined &&
    profile.notifyChannel !== undefined
  );
}

/** One class a user wants booked, every week. */
export interface Subscription {
  id: string;
  userId: string;
  /** Either Elixia's numeric club id, or the club's exact name. */
  center: string;
  className: string;
  weekday: Weekday;
  startTime: string;
  priority: number;
  enabled: boolean;
  /** Overrides the profile's tier for this class only. */
  bookingWindowDays?: number;
  /**
   * When this class was first found missing from Elixia's published schedule,
   * or absent while it is listed.
   *
   * The first moment rather than the latest, because "gone since Tuesday" is
   * what makes the warning actionable — and because a class off for a holiday
   * week reads very differently from one gone for a month.
   */
  unlistedSinceMs?: number;
  /**
   * Who is currently running this class, as last seen on Elixia's schedule.
   *
   * Kept separately from the subscription's own fields because it is not
   * something the user chose — it is refreshed nightly by its own job (see
   * `refreshInstructors`), deliberately apart from the booking and
   * listing-check logic, so a change to how instructors are read cannot break
   * either. Absent until the first refresh finds one, and left alone (not
   * cleared) on a night the class cannot be read at all.
   */
  instructorName?: string;
  /**
   * The classDate (YYYY-MM-DD) of this subscription's soonest upcoming
   * occurrence, as of the last time it was checked against a *published* day
   * of Elixia's schedule and found genuinely missing from it.
   *
   * Not the same thing as `unlistedSinceMs`: that is for a class Elixia has
   * withdrawn altogether, gone from every date in the published window. This
   * is for one specific date coming up missing while the weekly slot
   * otherwise still runs — some Elixia classes are one-off, so a date
   * flagged here says nothing about the date after it. It always names the
   * occurrence it was checked against, so a fresh check either clears it
   * (the date is now listed, or the soonest upcoming date has moved on) or
   * refiles it against whatever date is now soonest — nothing here outlives
   * the occurrence it names.
   */
  unavailableClassDate?: string;
  createdAtMs: number;
}

/** A precomputed "booking opens at this instant" pointer. */
export interface DueEntry {
  userId: string;
  subscriptionId: string;
  releaseEpochMs: number;
  classEpochMs: number;
  classDate: string;
  releaseNote?: 'gap' | 'ambiguous';
}

/** What the UI shows for a past attempt. */
export interface BookingHistoryEntry {
  atMs: number;
  subscriptionId: string | null;
  className: string;
  classDate: string;
  startTime: string;
  outcome: AttemptOutcome['kind'];
  detail?: string;
  attempts: number;
  firstAttemptOffsetMs: number | null;
  dryRun: boolean;
  /**
   * The centre this class was at, for the calendar feed's event location.
   * Absent on rows written before this field existed.
   */
  center?: string;
  /**
   * When this booking was found no longer held — cancelled through Elixia's
   * own app or site, since this app never cancels one itself. Set by the
   * nightly `reviewBookedOccurrences` sweep, and the reason the calendar feed
   * stops serving an event for it: see `lib/calendarFeed.ts`.
   */
  cancelledAtMs?: number;
}
