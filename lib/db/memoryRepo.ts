/**
 * In-memory Repo.
 *
 * Used by the test suite, and by `npm run dev` before Neon is configured so
 * the app is runnable with nothing installed. It reproduces the constraints the
 * database enforces — the duplicate-class unique index, and cascade on delete —
 * because a fake that is more permissive than production hides exactly the bugs
 * the tests exist to catch.
 *
 * Not suitable for production: serverless invocations do not share memory.
 */

import { CLAIM_LEASE_MS, DuplicateSubscriptionError, type NewSubscription, type Repo } from './repo';
import type { BookingHistoryEntry, DueEntry, Profile, Subscription } from '../types';

/** A due entry as stored, with the claim bookkeeping `Repo` callers never see. */
type StoredDueEntry = DueEntry & { claimedAtMs?: number };

export interface MemoryRepo extends Repo {
  /** Test hook: everything persisted, for asserting on what was written. */
  dump(): string;
}

export function createMemoryRepo(): MemoryRepo {
  const profiles = new Map<string, Profile>();
  const subscriptions = new Map<string, Subscription>();
  const dueEntries: StoredDueEntry[] = [];
  const history = new Map<string, BookingHistoryEntry[]>();
  let nextId = 1;

  const duplicateKey = (s: {
    userId: string;
    className: string;
    center: string;
    weekday: string;
    startTime: string;
  }): string =>
    [s.userId, s.className.toLowerCase(), s.center.toLowerCase(), s.weekday, s.startTime].join('|');

  return {
    async getProfile(userId) {
      return profiles.get(userId) ?? null;
    },

    async upsertProfile(profile) {
      profiles.set(profile.id, { ...profile });
    },

    async listLinkedProfiles() {
      return [...profiles.values()].filter((p) => p.elixiaStatus === 'ok');
    },

    async listSubscriptions(userId) {
      return [...subscriptions.values()]
        .filter((s) => s.userId === userId)
        .sort((a, b) => a.priority - b.priority);
    },

    async createSubscription(input: NewSubscription) {
      const key = duplicateKey(input);
      for (const existing of subscriptions.values()) {
        if (duplicateKey(existing) === key) throw new DuplicateSubscriptionError();
      }

      const subscription: Subscription = {
        id: `sub-${nextId++}`,
        userId: input.userId,
        className: input.className,
        center: input.center,
        weekday: input.weekday,
        startTime: input.startTime,
        priority: input.priority,
        enabled: true,
        ...(input.bookingWindowDays !== undefined
          ? { bookingWindowDays: input.bookingWindowDays }
          : {}),
        createdAtMs: Date.now(),
      };
      subscriptions.set(subscription.id, subscription);
      return subscription;
    },

    async deleteSubscription(userId, id) {
      const existing = subscriptions.get(id);
      if (!existing || existing.userId !== userId) return false;

      subscriptions.delete(id);
      // Mirrors the schema's ON DELETE CASCADE, so a removed class cannot leave
      // a pointer the cron might still act on.
      for (let i = dueEntries.length - 1; i >= 0; i--) {
        if (dueEntries[i]!.subscriptionId === id) dueEntries.splice(i, 1);
      }
      return true;
    },

    async setSubscriptionEnabled(userId, id, enabled) {
      const existing = subscriptions.get(id);
      if (!existing || existing.userId !== userId) return false;
      subscriptions.set(id, { ...existing, enabled });
      return true;
    },

    async replaceDueEntries(userId, entries) {
      for (let i = dueEntries.length - 1; i >= 0; i--) {
        if (dueEntries[i]!.userId === userId) dueEntries.splice(i, 1);
      }
      dueEntries.push(...entries);
    },

    async claimDue(fromMs, toMs, nowMs = Date.now()) {
      const claimable = dueEntries.filter(
        (e) =>
          e.releaseEpochMs >= fromMs &&
          e.releaseEpochMs <= toMs &&
          (e.claimedAtMs === undefined || e.claimedAtMs < nowMs - CLAIM_LEASE_MS),
      );
      const claimed: DueEntry[] = claimable.map(({ claimedAtMs: _claimedAtMs, ...entry }) => entry);
      for (const e of claimable) e.claimedAtMs = nowMs;
      return claimed.sort((a, b) => a.releaseEpochMs - b.releaseEpochMs);
    },

    async peekNextRelease(afterMs, nowMs = Date.now()) {
      let earliest: number | null = null;
      for (const e of dueEntries) {
        if (e.claimedAtMs !== undefined && e.claimedAtMs >= nowMs - CLAIM_LEASE_MS) continue;
        if (e.releaseEpochMs < afterMs) continue;
        if (earliest === null || e.releaseEpochMs < earliest) earliest = e.releaseEpochMs;
      }
      return earliest;
    },

    async pruneDueEntries(beforeMs) {
      let removed = 0;
      for (let i = dueEntries.length - 1; i >= 0; i--) {
        if (dueEntries[i]!.releaseEpochMs < beforeMs) {
          dueEntries.splice(i, 1);
          removed++;
        }
      }
      return removed;
    },

    async appendHistory(userId, entry) {
      history.set(userId, [entry, ...(history.get(userId) ?? [])].slice(0, 50));
    },

    async listHistory(userId, limit = 50) {
      return (history.get(userId) ?? []).slice(0, limit);
    },

    dump() {
      return JSON.stringify({
        profiles: [...profiles.values()],
        subscriptions: [...subscriptions.values()],
        dueEntries,
        history: [...history.values()],
      });
    },
  };
}
