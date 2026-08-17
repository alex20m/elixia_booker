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
  /** Releases falling inside [fromMs, toMs]. One index scan. */
  claimDue(fromMs: number, toMs: number): Promise<DueEntry[]>;
  /** Housekeeping: drop entries whose release is long past. */
  pruneDueEntries(beforeMs: number): Promise<number>;

  appendHistory(userId: string, entry: BookingHistoryEntry): Promise<void>;
  listHistory(userId: string, limit?: number): Promise<BookingHistoryEntry[]>;
}
