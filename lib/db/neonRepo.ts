/**
 * Neon Postgres implementation of the Repo.
 *
 * Every statement is parameterised and every one of them names the user — reads
 * and writes alike, including ones already narrowed by a primary key. Under
 * Supabase that redundancy was belt-and-braces behind row-level security; here
 * it *is* the isolation, because the app holds a single database role and the
 * browser never speaks to Postgres at all. See the header of db/migrations/0001_initial_schema.sql.
 *
 * `date` columns are read through `to_char`. Drivers parse Postgres `date` into
 * a `Date` at UTC midnight, and a class date that becomes an instant is a class
 * date that can move a day when it is rendered or compared in another zone.
 * Classes are calendar-scheduled, so they stay strings from end to end.
 */

import { CLAIM_LEASE_MS, DuplicateSubscriptionError, type NewSubscription, type Repo } from './repo';
import {
  isInvalidTextRepresentation,
  isUniqueViolation,
  toMs,
  type Sql,
  type SqlRow,
  type Statement,
} from './sql';
import type {
  BookingHistoryEntry,
  DueEntry,
  ElixiaStatus,
  NotifyChannel,
  Profile,
  Subscription,
  Weekday,
} from '../types';

const PROFILE_COLUMNS = `
  id, booking_window_days, time_zone, notify_channel, notify_email, telegram_chat_id,
  elixia_email, elixia_secret, elixia_status, elixia_checked_at, default_center,
  configured_at
`;

const SUBSCRIPTION_COLUMNS = `
  id, user_id, class_name, center, weekday, start_time,
  priority, enabled, booking_window_days, unlisted_since, instructor_name,
  to_char(unavailable_class_date, 'YYYY-MM-DD') as unavailable_class_date, created_at
`;

const str = (value: unknown): string => String(value);
const num = (value: unknown): number => Number(value);

// Absent, not coerced: `num(null)` is 0 and `str(null)` is "null", and both
// would sail past a check for "has a value" as a booking window of zero days
// and a timezone no formatter can resolve. A profile that has not been through
// setup has to read back as one.
const toProfile = (row: SqlRow): Profile => ({
  id: str(row.id),
  ...(row.booking_window_days !== null && row.booking_window_days !== undefined
    ? { bookingWindowDays: num(row.booking_window_days) }
    : {}),
  ...(row.time_zone ? { timeZone: str(row.time_zone) } : {}),
  ...(row.notify_channel ? { notifyChannel: str(row.notify_channel) as NotifyChannel } : {}),
  ...(row.notify_email ? { notifyEmail: str(row.notify_email) } : {}),
  ...(row.telegram_chat_id ? { telegramChatId: str(row.telegram_chat_id) } : {}),
  ...(row.elixia_email ? { elixiaEmail: str(row.elixia_email) } : {}),
  ...(row.elixia_secret ? { elixiaSecret: str(row.elixia_secret) } : {}),
  elixiaStatus: str(row.elixia_status) as ElixiaStatus,
  ...(row.elixia_checked_at ? { elixiaCheckedAtMs: toMs(row.elixia_checked_at) } : {}),
  ...(row.default_center ? { defaultCenter: str(row.default_center) } : {}),
  ...(row.configured_at ? { configuredAtMs: toMs(row.configured_at) } : {}),
});

const toSubscription = (row: SqlRow): Subscription => ({
  id: str(row.id),
  userId: str(row.user_id),
  className: str(row.class_name),
  center: str(row.center),
  weekday: str(row.weekday) as Weekday,
  startTime: str(row.start_time),
  priority: num(row.priority),
  enabled: Boolean(row.enabled),
  ...(row.booking_window_days !== null && row.booking_window_days !== undefined
    ? { bookingWindowDays: num(row.booking_window_days) }
    : {}),
  ...(row.unlisted_since ? { unlistedSinceMs: toMs(row.unlisted_since) } : {}),
  ...(row.instructor_name ? { instructorName: str(row.instructor_name) } : {}),
  ...(row.unavailable_class_date ? { unavailableClassDate: str(row.unavailable_class_date) } : {}),
  createdAtMs: toMs(row.created_at),
});

const toDueEntry = (row: SqlRow): DueEntry => ({
  userId: str(row.user_id),
  subscriptionId: str(row.subscription_id),
  releaseEpochMs: toMs(row.release_at),
  classEpochMs: toMs(row.class_at),
  classDate: str(row.class_date),
  ...(row.release_note === 'gap' || row.release_note === 'ambiguous'
    ? { releaseNote: row.release_note }
    : {}),
});

const toHistoryEntry = (row: SqlRow): BookingHistoryEntry => ({
  atMs: toMs(row.created_at),
  subscriptionId: row.subscription_id === null ? null : str(row.subscription_id),
  className: str(row.class_name),
  classDate: str(row.class_date),
  startTime: str(row.start_time),
  outcome: str(row.outcome) as BookingHistoryEntry['outcome'],
  ...(row.detail ? { detail: str(row.detail) } : {}),
  attempts: num(row.attempts),
  firstAttemptOffsetMs:
    row.first_attempt_offset_ms === null ? null : num(row.first_attempt_offset_ms),
  dryRun: Boolean(row.dry_run),
});

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

/**
 * Rows a bad id cannot match.
 *
 * A subscription id arrives from the URL, so it need not be a uuid at all.
 * Postgres rejects the cast rather than returning nothing, which would surface
 * as a 500 where the honest answer is "no such class".
 */
async function rowsOrNoneForBadId(run: () => Promise<SqlRow[]>): Promise<SqlRow[]> {
  try {
    return await run();
  } catch (err) {
    if (isInvalidTextRepresentation(err)) return [];
    throw err;
  }
}

export function createNeonRepo(sql: Sql): Repo {
  return {
    async getProfile(userId) {
      const rows = await sql.query(
        `select ${PROFILE_COLUMNS} from public.profiles where id = $1`,
        [userId],
      );
      return rows[0] ? toProfile(rows[0]) : null;
    },

    async upsertProfile(profile) {
      // Every column is written on conflict, not just the ones that happen to
      // be set: unlinking is an upsert whose whole purpose is to blank the
      // stored credentials, and a partial update would leave the password
      // sitting in the row it was supposed to erase.
      await sql.query(
        `insert into public.profiles (
           id, booking_window_days, time_zone, notify_channel, notify_email, telegram_chat_id,
           elixia_email, elixia_secret, elixia_status, elixia_checked_at, default_center,
           configured_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12::timestamptz)
         on conflict (id) do update set
           booking_window_days = excluded.booking_window_days,
           time_zone = excluded.time_zone,
           notify_channel = excluded.notify_channel,
           notify_email = excluded.notify_email,
           telegram_chat_id = excluded.telegram_chat_id,
           elixia_email = excluded.elixia_email,
           elixia_secret = excluded.elixia_secret,
           elixia_status = excluded.elixia_status,
           elixia_checked_at = excluded.elixia_checked_at,
           default_center = excluded.default_center,
           configured_at = excluded.configured_at`,
        [
          profile.id,
          // Null where the user has not chosen yet — the columns lost their
          // defaults in 0009 precisely so that state can be stored honestly
          // rather than dressed up as a membership tier nobody signed for.
          profile.bookingWindowDays ?? null,
          profile.timeZone ?? null,
          profile.notifyChannel ?? null,
          profile.notifyEmail ?? null,
          profile.telegramChatId ?? null,
          profile.elixiaEmail ?? null,
          profile.elixiaSecret ?? null,
          profile.elixiaStatus,
          profile.elixiaCheckedAtMs ? iso(profile.elixiaCheckedAtMs) : null,
          profile.defaultCenter ?? null,
          profile.configuredAtMs ? iso(profile.configuredAtMs) : null,
        ],
      );
    },

    async listLinkedProfiles() {
      const rows = await sql.query(
        `select ${PROFILE_COLUMNS} from public.profiles where elixia_status = 'ok'`,
      );
      return rows.map(toProfile);
    },

    async deleteProfile(userId) {
      // The foreign keys carry the rest: subscriptions, due_entries and
      // booking_history all reference profiles with `on delete cascade`.
      await sql.query(`delete from public.profiles where id = $1`, [userId]);
    },

    async listSubscriptions(userId) {
      const rows = await sql.query(
        `select ${SUBSCRIPTION_COLUMNS} from public.subscriptions
         where user_id = $1
         order by priority asc, created_at asc`,
        [userId],
      );
      return rows.map(toSubscription);
    },

    async createSubscription(subscription: NewSubscription) {
      try {
        const rows = await sql.query(
          `insert into public.subscriptions (
             user_id, class_name, center, weekday, start_time, priority, booking_window_days
           )
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${SUBSCRIPTION_COLUMNS}`,
          [
            subscription.userId,
            subscription.className,
            subscription.center,
            subscription.weekday,
            subscription.startTime,
            subscription.priority,
            subscription.bookingWindowDays ?? null,
          ],
        );
        return toSubscription(rows[0]!);
      } catch (err) {
        // The unique index is the real guard: it also stops two concurrent
        // requests from both getting through the app-level check.
        if (isUniqueViolation(err)) throw new DuplicateSubscriptionError();
        throw err;
      }
    },

    async deleteSubscription(userId, id) {
      const rows = await rowsOrNoneForBadId(() =>
        sql.query(
          `delete from public.subscriptions where user_id = $1 and id = $2::uuid returning id`,
          [userId, id],
        ),
      );
      return rows.length > 0;
    },

    async setSubscriptionEnabled(userId, id, enabled) {
      const rows = await rowsOrNoneForBadId(() =>
        sql.query(
          `update public.subscriptions set enabled = $3
           where user_id = $1 and id = $2::uuid
           returning id`,
          [userId, id, enabled],
        ),
      );
      return rows.length > 0;
    },

    async setSubscriptionUnlisted(userId, id, atMs) {
      const rows = await rowsOrNoneForBadId(() =>
        sql.query(
          `update public.subscriptions set unlisted_since = $3
           where user_id = $1 and id = $2::uuid
           returning id`,
          [userId, id, atMs === null ? null : new Date(atMs).toISOString()],
        ),
      );
      return rows.length > 0;
    },

    async setSubscriptionUnavailableDate(userId, id, classDate) {
      const rows = await rowsOrNoneForBadId(() =>
        sql.query(
          `update public.subscriptions set unavailable_class_date = $3::date
           where user_id = $1 and id = $2::uuid
           returning id`,
          [userId, id, classDate],
        ),
      );
      return rows.length > 0;
    },

    async setSubscriptionInstructor(userId, id, name) {
      const rows = await rowsOrNoneForBadId(() =>
        sql.query(
          `update public.subscriptions set instructor_name = $3
           where user_id = $1 and id = $2::uuid
           returning id`,
          [userId, id, name],
        ),
      );
      return rows.length > 0;
    },

    async replaceDueEntries(userId, entries) {
      const clear: Statement = {
        text: `delete from public.due_entries where user_id = $1`,
        params: [userId],
      };

      if (entries.length === 0) {
        await sql.query(clear.text, clear.params);
        return;
      }

      // Delete-then-insert rather than upsert: a subscription that was paused
      // or retimed must not leave its old release behind. Both halves go in one
      // transaction so a failure cannot leave the account unscheduled.
      const params: unknown[] = [userId];
      const tuples = entries.map((entry) => {
        const at = params.length + 1;
        params.push(
          entry.subscriptionId,
          iso(entry.releaseEpochMs),
          iso(entry.classEpochMs),
          entry.classDate,
          entry.releaseNote ?? null,
        );
        return `($1, $${at}::uuid, $${at + 1}::timestamptz, $${at + 2}::timestamptz, $${at + 3}::date, $${at + 4})`;
      });

      await sql.transaction([
        clear,
        {
          text: `insert into public.due_entries (
                   user_id, subscription_id, release_at, class_at, class_date, release_note
                 )
                 values ${tuples.join(', ')}`,
          params,
        },
      ]);
    },

    async claimDue(fromMs, toMs, nowMs = Date.now()) {
      // A CTE selects the claimable rows — unclaimed, or whose claim expired
      // — and locks them (`skip locked` so a concurrent caller does not block
      // behind this one), then the UPDATE stamps and returns exactly those.
      // One statement, so two overlapping callers can never both claim the
      // same row: see CLAIM_LEASE_MS.
      const rows = await sql.query(
        `with claimable as (
           select id from public.due_entries
           where (claimed_at is null or claimed_at < $4::timestamptz)
             and release_at >= $1::timestamptz and release_at <= $2::timestamptz
           for update skip locked
         )
         update public.due_entries d
         set claimed_at = $3::timestamptz
         from claimable
         where d.id = claimable.id
         returning d.user_id, d.subscription_id, d.release_at, d.class_at,
                   to_char(d.class_date, 'YYYY-MM-DD') as class_date, d.release_note`,
        [iso(fromMs), iso(toMs), iso(nowMs), iso(nowMs - CLAIM_LEASE_MS)],
      );
      return rows.map(toDueEntry).sort((a, b) => a.releaseEpochMs - b.releaseEpochMs);
    },

    async pruneDueEntries(beforeMs) {
      const rows = await sql.query(
        `delete from public.due_entries where release_at < $1::timestamptz returning id`,
        [iso(beforeMs)],
      );
      return rows.length;
    },

    async createTelegramLink(userId, tokenHash, expiresAtMs, nowMs) {
      // Both statements in one transaction: between the delete and the insert
      // this user has no pending link, and a reader that saw that gap would
      // conclude a connect attempt that is actually in progress had failed.
      // The sweep of expired rows rides along, so nothing else has to own it.
      await sql.transaction([
        {
          text: `delete from public.telegram_link_tokens
                  where user_id = $1 or expires_at <= $2::timestamptz`,
          params: [userId, iso(nowMs)],
        },
        {
          text: `insert into public.telegram_link_tokens (token_hash, user_id, expires_at)
                 values ($1, $2, $3::timestamptz)`,
          params: [tokenHash, userId, iso(expiresAtMs)],
        },
      ]);
    },

    async claimTelegramLink(tokenHash, nowMs) {
      // One statement, so two requests presenting the same token cannot both
      // be handed the account: exactly one DELETE returns the row. Expiry is
      // part of the predicate rather than a check afterwards, but the row goes
      // either way — a token that has been presented is spent.
      const rows = await sql.query(
        `delete from public.telegram_link_tokens
          where token_hash = $1
          returning user_id, expires_at`,
        [tokenHash],
      );

      const row = rows[0];
      if (!row) return null;
      return toMs(row.expires_at) > nowMs ? str(row.user_id) : null;
    },

    async appendHistory(userId, entry) {
      await sql.query(
        `insert into public.booking_history (
           user_id, subscription_id, class_name, class_date, start_time,
           outcome, detail, attempts, first_attempt_offset_ms, dry_run, created_at
         )
         values ($1, $2::uuid, $3, $4::date, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [
          userId,
          entry.subscriptionId,
          entry.className,
          entry.classDate,
          entry.startTime,
          entry.outcome,
          entry.detail ?? null,
          entry.attempts,
          entry.firstAttemptOffsetMs,
          entry.dryRun,
          iso(entry.atMs),
        ],
      );
    },

    async listHistory(userId, limit = 50) {
      const rows = await sql.query(
        `select subscription_id, class_name, to_char(class_date, 'YYYY-MM-DD') as class_date,
                start_time, outcome, detail, attempts, first_attempt_offset_ms, dry_run, created_at
         from public.booking_history
         where user_id = $1
         order by created_at desc
         limit $2`,
        [userId, limit],
      );
      return rows.map(toHistoryEntry);
    },
  };
}
