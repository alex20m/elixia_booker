/**
 * Supabase Postgres implementation of the Repo.
 *
 * Callers pass whichever client is appropriate: the browser-facing one carries
 * the user's JWT and is constrained by row-level security, while the cron uses
 * the service-role client, which bypasses RLS because it legitimately acts for
 * every user at once.
 *
 * The queries still filter by user id even under RLS. That is deliberate
 * belt-and-braces: the service-role path has no policy protecting it, so the
 * filter is the only thing standing between a bug and cross-user data.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DuplicateSubscriptionError, type NewSubscription, type Repo } from './repo';
import type {
  BookingHistoryEntry,
  DueEntry,
  ElixiaStatus,
  Profile,
  Subscription,
  Weekday,
} from '../types';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

interface ProfileRow {
  id: string;
  booking_window_days: number;
  time_zone: string;
  telegram_chat_id: string | null;
  elixia_email: string | null;
  elixia_secret: string | null;
  elixia_status: ElixiaStatus;
  elixia_checked_at: string | null;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  class_name: string;
  center: string;
  weekday: Weekday;
  start_time: string;
  on_full: 'waitlist' | 'skip';
  priority: number;
  enabled: boolean;
  booking_window_days: number | null;
  created_at: string;
}

interface DueRow {
  user_id: string;
  subscription_id: string;
  release_at: string;
  class_at: string;
  class_date: string;
  release_note: string | null;
}

interface HistoryRow {
  subscription_id: string | null;
  class_name: string;
  class_date: string;
  start_time: string;
  outcome: string;
  detail: string | null;
  attempts: number;
  first_attempt_offset_ms: number | null;
  dry_run: boolean;
  created_at: string;
}

const toProfile = (row: ProfileRow): Profile => ({
  id: row.id,
  bookingWindowDays: row.booking_window_days,
  timeZone: row.time_zone,
  ...(row.telegram_chat_id ? { telegramChatId: row.telegram_chat_id } : {}),
  ...(row.elixia_email ? { elixiaEmail: row.elixia_email } : {}),
  ...(row.elixia_secret ? { elixiaSecret: row.elixia_secret } : {}),
  elixiaStatus: row.elixia_status,
  ...(row.elixia_checked_at ? { elixiaCheckedAtMs: Date.parse(row.elixia_checked_at) } : {}),
});

const toSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  userId: row.user_id,
  className: row.class_name,
  center: row.center,
  weekday: row.weekday,
  startTime: row.start_time,
  onFull: row.on_full,
  priority: row.priority,
  enabled: row.enabled,
  ...(row.booking_window_days !== null ? { bookingWindowDays: row.booking_window_days } : {}),
  createdAtMs: Date.parse(row.created_at),
});

const toDueEntry = (row: DueRow): DueEntry => ({
  userId: row.user_id,
  subscriptionId: row.subscription_id,
  releaseEpochMs: Date.parse(row.release_at),
  classEpochMs: Date.parse(row.class_at),
  classDate: row.class_date,
  ...(row.release_note === 'gap' || row.release_note === 'ambiguous'
    ? { releaseNote: row.release_note }
    : {}),
});

/** Turn a PostgrestError into something a caller can act on. */
function raise(context: string, error: { message: string; code?: string } | null): void {
  if (!error) return;
  if (error.code === UNIQUE_VIOLATION) throw new DuplicateSubscriptionError();
  throw new Error(`${context}: ${error.message}`);
}

export function createSupabaseRepo(client: SupabaseClient): Repo {
  return {
    async getProfile(userId) {
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      raise('load profile', error);
      return data ? toProfile(data as ProfileRow) : null;
    },

    async upsertProfile(profile) {
      const { error } = await client.from('profiles').upsert({
        id: profile.id,
        booking_window_days: profile.bookingWindowDays,
        time_zone: profile.timeZone,
        telegram_chat_id: profile.telegramChatId ?? null,
        elixia_email: profile.elixiaEmail ?? null,
        elixia_secret: profile.elixiaSecret ?? null,
        elixia_status: profile.elixiaStatus,
        elixia_checked_at: profile.elixiaCheckedAtMs
          ? new Date(profile.elixiaCheckedAtMs).toISOString()
          : null,
      });
      raise('save profile', error);
    },

    async listLinkedProfiles() {
      const { data, error } = await client.from('profiles').select('*').eq('elixia_status', 'ok');
      raise('list profiles', error);
      return ((data ?? []) as ProfileRow[]).map(toProfile);
    },

    async listSubscriptions(userId) {
      const { data, error } = await client
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('priority', { ascending: true });
      raise('list subscriptions', error);
      return ((data ?? []) as SubscriptionRow[]).map(toSubscription);
    },

    async createSubscription(subscription: NewSubscription) {
      const { data, error } = await client
        .from('subscriptions')
        .insert({
          user_id: subscription.userId,
          class_name: subscription.className,
          center: subscription.center,
          weekday: subscription.weekday,
          start_time: subscription.startTime,
          on_full: subscription.onFull,
          priority: subscription.priority,
          booking_window_days: subscription.bookingWindowDays ?? null,
        })
        .select()
        .single();
      raise('create subscription', error);
      return toSubscription(data as SubscriptionRow);
    },

    async deleteSubscription(userId, id) {
      const { data, error } = await client
        .from('subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('id', id)
        .select('id');
      raise('delete subscription', error);
      return (data ?? []).length > 0;
    },

    async setSubscriptionEnabled(userId, id, enabled) {
      const { data, error } = await client
        .from('subscriptions')
        .update({ enabled })
        .eq('user_id', userId)
        .eq('id', id)
        .select('id');
      raise('update subscription', error);
      return (data ?? []).length > 0;
    },

    async replaceDueEntries(userId, entries) {
      // Delete-then-insert rather than upsert: a subscription that was paused or
      // retimed must not leave its old release behind, and the set is small.
      const { error: deleteError } = await client.from('due_entries').delete().eq('user_id', userId);
      raise('clear due entries', deleteError);

      if (entries.length === 0) return;

      const { error } = await client.from('due_entries').insert(
        entries.map((entry) => ({
          user_id: entry.userId,
          subscription_id: entry.subscriptionId,
          release_at: new Date(entry.releaseEpochMs).toISOString(),
          class_at: new Date(entry.classEpochMs).toISOString(),
          class_date: entry.classDate,
          release_note: entry.releaseNote ?? null,
        })),
      );
      raise('write due entries', error);
    },

    async claimDue(fromMs, toMs) {
      const { data, error } = await client
        .from('due_entries')
        .select('*')
        .gte('release_at', new Date(fromMs).toISOString())
        .lte('release_at', new Date(toMs).toISOString())
        .order('release_at', { ascending: true });
      raise('claim due entries', error);
      return ((data ?? []) as DueRow[]).map(toDueEntry);
    },

    async pruneDueEntries(beforeMs) {
      const { data, error } = await client
        .from('due_entries')
        .delete()
        .lt('release_at', new Date(beforeMs).toISOString())
        .select('id');
      raise('prune due entries', error);
      return (data ?? []).length;
    },

    async appendHistory(userId, entry) {
      const { error } = await client.from('booking_history').insert({
        user_id: userId,
        subscription_id: entry.subscriptionId,
        class_name: entry.className,
        class_date: entry.classDate,
        start_time: entry.startTime,
        outcome: entry.outcome,
        detail: entry.detail ?? null,
        attempts: entry.attempts,
        first_attempt_offset_ms: entry.firstAttemptOffsetMs,
        dry_run: entry.dryRun,
        created_at: new Date(entry.atMs).toISOString(),
      });
      raise('append history', error);
    },

    async listHistory(userId, limit = 50) {
      const { data, error } = await client
        .from('booking_history')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      raise('list history', error);

      return ((data ?? []) as HistoryRow[]).map((row) => ({
        atMs: Date.parse(row.created_at),
        subscriptionId: row.subscription_id,
        className: row.class_name,
        classDate: row.class_date,
        startTime: row.start_time,
        outcome: row.outcome as BookingHistoryEntry['outcome'],
        ...(row.detail ? { detail: row.detail } : {}),
        attempts: row.attempts,
        firstAttemptOffsetMs: row.first_attempt_offset_ms,
        dryRun: row.dry_run,
      }));
    },
  };
}
