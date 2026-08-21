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

/** One account, keyed by the Neon Auth user id. */
export interface Profile {
  id: string;
  bookingWindowDays: number;
  timeZone: string;
  telegramChatId?: string;
  /** Shown in the UI so the user can see which gym account is linked. */
  elixiaEmail?: string;
  /** AES-256-GCM sealed SealedElixiaSecret. Absent when unlinked. */
  elixiaSecret?: string;
  elixiaStatus: ElixiaStatus;
  elixiaCheckedAtMs?: number;
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
}
