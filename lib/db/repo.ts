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
 * per-minute cron must stay one index scan no matter how many users exist.
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
 * Two callers can legitimately race for the same release: the per-minute
 * safety-net tick (cron.yml) and the high-precision watcher (watch.yml) both
 * end up asking for "what's due right now" within seconds of each other.
 * `claimDue` hands a release to only one of them — but if that caller then
 * crashes or is killed mid-attempt (a serverless invocation hitting its own
 * `maxDuration`, at most 300s on Vercel Pro), the release must not stay
 * claimed forever with nobody ever retrying it. Comfortably above that ceiling
 * so a claim is never reclaimed out from under an attempt still legitimately
 * in flight.
 */
export const CLAIM_LEASE_MS = 6 * 60_000;

/** A subscription as submitted by the UI, before it has an id. */
export interface NewSubscription {
  userId: string;
  className: string;
  center: string;
  weekday: Subscription['weekday'];
  startTime: string;
  onFull: Subscription['onFull'];
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
  upsertProfile(profile: Profile): Promise<void>;
  /** Every profile with a usable Elixia link. Used by the nightly reindex. */
  listLinkedProfiles(): Promise<Profile[]>;

  listSubscriptions(userId: string): Promise<Subscription[]>;
  createSubscription(subscription: NewSubscription): Promise<Subscription>;
  deleteSubscription(userId: string, id: string): Promise<boolean>;
  setSubscriptionEnabled(userId: string, id: string, enabled: boolean): Promise<boolean>;

  /** Replace a user's scheduled releases with a freshly computed set. */
  replaceDueEntries(userId: string, entries: DueEntry[]): Promise<void>;
  /**
   * Releases falling inside [fromMs, toMs], claimed atomically so each one is
   * handed to exactly one caller — see `CLAIM_LEASE_MS`. One index scan.
   */
  claimDue(fromMs: number, toMs: number, nowMs?: number): Promise<DueEntry[]>;
  /**
   * The earliest unclaimed release at or after `afterMs`, or null if nothing
   * is scheduled that far out. A read, not a claim — for the watcher to sleep
   * to the exact instant using its own clock, without taking the release.
   */
  peekNextRelease(afterMs: number, nowMs?: number): Promise<number | null>;
  /** Housekeeping: drop entries whose release is long past. */
  pruneDueEntries(beforeMs: number): Promise<number>;

  appendHistory(userId: string, entry: BookingHistoryEntry): Promise<void>;
  listHistory(userId: string, limit?: number): Promise<BookingHistoryEntry[]>;
}
