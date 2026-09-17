/**
 * The data-access contract.
 *
 * Everything above this interface is storage-agnostic, which is what let the app
 * move from Workers KV to Redis to Postgres without the booking logic changing.
 * Two implementations exist: Neon Postgres (production) and in-memory
 * (tests, and local dev before a database is configured).
 *
 * The operations are shaped around what the app actually does. In particular
 * `claimDue` takes a time window rather than "give me everything", because the
 * booking tick must stay one index scan no matter how many users exist.
 */

import type {
  BookingHistoryEntry,
  DueEntry,
  Profile,
  Subscription,
} from '../types';

/**
 * How long a claim holds before it is treated as abandoned and becomes
 * reclaimable.
 *
 * QStash guarantees at-least-once delivery, so two ticks can plausibly run for
 * the same release: a delivery is retried, or one instant produces a duplicate
 * message, and both land inside the same ±60s claim window. Without a claim,
 * the second would find the same row and fire it again. `claimDue` hands a
 * release to only the first caller — but if that caller then crashes or is
 * killed mid-attempt (a serverless invocation hitting its own `maxDuration`,
 * at most 300s on Vercel Pro), the release must not stay claimed forever with
 * nobody ever retrying it. Comfortably above that ceiling so a claim is never
 * reclaimed out from under an attempt still legitimately in flight.
 */
export const CLAIM_LEASE_MS = 6 * 60_000;

/** A subscription as submitted by the UI, before it has an id. */
export interface NewSubscription {
  userId: string;
  className: string;
  center: string;
  weekday: Subscription['weekday'];
  startTime: string;
  priority: number;
  bookingWindowDays?: number;
}

/** Raised when the unique index rejects a duplicate class. */
export class DuplicateSubscriptionError extends Error {
  constructor() {
    super('You have already added that class');
    this.name = 'DuplicateSubscriptionError';
  }
}

export interface Repo {
  getProfile(userId: string): Promise<Profile | null>;
  /**
   * The profile owning a calendar feed token, or null if it names none.
   *
   * The one lookup the public ICS route needs, since it has no session to
   * resolve a user from — the token in the URL *is* the credential.
   */
  getProfileByCalendarToken(token: string): Promise<Profile | null>;
  upsertProfile(profile: Profile): Promise<void>;
  /** Every profile with a usable Elixia link. Used by the nightly reindex. */
  listLinkedProfiles(): Promise<Profile[]>;
  /**
   * Wipe everything the app itself stored for this user: the profile row —
   * including the sealed Elixia secret — and, through the same cascade that
   * protects a removed class, its subscriptions, scheduled releases and
   * history. Called once account deletion in Neon Auth has actually happened,
   * not merely requested, so this never runs ahead of the identity it follows.
   */
  deleteProfile(userId: string): Promise<void>;

  listSubscriptions(userId: string): Promise<Subscription[]>;
  createSubscription(subscription: NewSubscription): Promise<Subscription>;
  deleteSubscription(userId: string, id: string): Promise<boolean>;
  setSubscriptionEnabled(userId: string, id: string, enabled: boolean): Promise<boolean>;
  /** Records when a class went missing from the schedule; null once it is back. */
  setSubscriptionUnlisted(userId: string, id: string, atMs: number | null): Promise<boolean>;
  /**
   * Records the classDate (YYYY-MM-DD) of a subscription's soonest upcoming
   * occurrence when it is confirmed missing from a published day; null once
   * it is checked and found present, or the checked occurrence has rolled
   * forward to a new date. See `Subscription.unavailableClassDate`.
   */
  setSubscriptionUnavailableDate(userId: string, id: string, classDate: string | null): Promise<boolean>;
  /**
   * Records who the schedule currently says is running a class; null to clear
   * a name that no longer applies. Written by the nightly instructor refresh,
   * never by booking or listing-check logic.
   */
  setSubscriptionInstructor(userId: string, id: string, name: string | null): Promise<boolean>;

  /** Replace a user's scheduled releases with a freshly computed set. */
  replaceDueEntries(userId: string, entries: DueEntry[]): Promise<void>;
  /**
   * Releases falling inside [fromMs, toMs], claimed atomically so each one is
   * handed to exactly one caller — see `CLAIM_LEASE_MS`. One index scan.
   */
  claimDue(fromMs: number, toMs: number, nowMs?: number): Promise<DueEntry[]>;
  /** Housekeeping: drop entries whose release is long past. */
  pruneDueEntries(beforeMs: number): Promise<number>;

  /**
   * Begin a Telegram connect attempt, replacing whatever this user had pending.
   *
   * Takes the *hash* of the token, never the token: see lib/telegramLink.ts.
   * Replacing rather than accumulating is what keeps a token's usable life to
   * the advertised window — an abandoned attempt must not leave a working link
   * behind it. Expired rows for *other* users are swept at the same time, so
   * abandoned attempts do not accumulate without anything owning their removal.
   *
   * `nowMs` comes from the caller rather than from the database's `now()`, the
   * same way `claimDue` takes it: a repo that reads two different clocks — the
   * caller's on one operation and the server's on another — behaves one way
   * under test and another in production, and the disagreement shows up as
   * rows vanishing early.
   */
  createTelegramLink(
    userId: string,
    tokenHash: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<void>;
  /**
   * Consume a pending link, returning the user it belonged to, or null if the
   * token is unknown, already used, or expired.
   *
   * Single-use has to hold against two requests arriving together — the
   * webhook is public and a retry is one network hiccup away — so the read and
   * the delete are one statement, not a check followed by a write.
   */
  claimTelegramLink(tokenHash: string, nowMs: number): Promise<string | null>;

  appendHistory(userId: string, entry: BookingHistoryEntry): Promise<void>;
  listHistory(userId: string, limit?: number): Promise<BookingHistoryEntry[]>;
  /**
   * Record that a booking no longer holds — see `BookingHistoryEntry.cancelledAtMs`.
   *
   * Matched by subscription and class date rather than a history row id: those
   * two together already name one occurrence uniquely (the same pair
   * `lib/calendarFeed.ts` builds its event UID from), and the caller who wants
   * this — `reviewBookedOccurrences` — has never had a reason to look up a raw
   * row id. A no-op (returns false) if the row is already marked, or does not
   * exist, or is not one of the outcomes that could ever have held a place.
   */
  markHistoryCancelled(
    userId: string,
    subscriptionId: string,
    classDate: string,
    nowMs: number,
  ): Promise<boolean>;
}
