-- Elixia Booker schema (Neon Postgres) — the first migration.
--
-- Applied by `npm run migrate` (node-pg-migrate), and automatically on every
-- merge to main. Editing it once it has run anywhere does nothing: migrations
-- are recorded by file name and never applied twice. Schema changes go in a
-- new numbered file beside this one (see SETUP.md).
--
-- Three things shape it:
--
--  1. **Identity lives in Neon Auth, data lives here.** Every row is keyed by
--     the Neon Auth (Stack) user id, which is an opaque string rather than a
--     uuid — hence `text`. Neon Auth mirrors its users into
--     `neon_auth.users_sync`, but nothing here has a foreign key to it: that
--     mirror is populated asynchronously, so a profile written seconds after
--     signup would be rejected by the constraint it was supposed to protect.
--     Reaping orphans is a query, not a constraint — see the bottom of this
--     file.
--
--  2. **No row-level security, because nothing untrusted holds a connection.**
--     Under Supabase the browser talked to Postgres directly with the user's
--     JWT, so RLS was the boundary. Here every query is made by the server
--     through one role, after `requireUser()` has resolved the session, and the
--     browser never sees a connection string. The isolation is therefore the
--     `user_id = $1` predicate on every statement in lib/db/neonRepo.ts — which
--     is why it is present on every read *and* every write, including ones
--     already narrowed by a primary key.
--
--  3. **Foreign keys cascade.** Deleting a subscription deletes its scheduled
--     bookings, so a removed class cannot leave behind a pointer that the cron
--     might still act on.

-- ---------------------------------------------------------------------------
-- profiles: one row per Neon Auth user
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  -- The Neon Auth (Stack) user id. Created by the app on first authenticated
  -- request, not by a database trigger: there is no local auth table to hang
  -- one off, and a user who signed in but has no profile yet would otherwise
  -- fail every subsequent query.
  id text primary key,
  booking_window_days integer not null default 7
    check (booking_window_days between 0 and 60),
  time_zone text not null default 'Europe/Helsinki',
  telegram_chat_id text,

  -- Shown in the UI so a user can see which gym account is linked. Not a
  -- credential on its own.
  elixia_email text,

  -- AES-256-GCM sealed blob holding the Elixia password and tokens. The key
  -- lives only in the app's environment, never in this database, so a dump of
  -- this table is inert.
  elixia_secret text,

  elixia_status text not null default 'unlinked'
    check (elixia_status in ('unlinked', 'ok', 'expired')),
  elixia_checked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- subscriptions: the classes a user wants booked, weekly
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  class_name text not null,
  center text not null,
  weekday text not null check (
    weekday in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')
  ),
  start_time text not null,
  on_full text not null default 'waitlist' check (on_full in ('waitlist', 'skip')),
  priority integer not null default 1,
  enabled boolean not null default true,
  booking_window_days integer check (booking_window_days between 0 and 60),
  created_at timestamptz not null default now()
);

-- Two identical subscriptions would fire two simultaneous booking attempts for
-- the same slot at T-0 — self-competing, and indistinguishable from abuse at
-- Elixia's end. The app checks for this too; enforcing it here means a race
-- between two concurrent requests still cannot create one.
create unique index if not exists subscriptions_unique_class
  on public.subscriptions (user_id, lower(class_name), lower(center), weekday, start_time);

create index if not exists subscriptions_user on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- due_entries: precomputed "booking opens at this instant" pointers
-- ---------------------------------------------------------------------------
--
-- The cron runs every minute. Without this it would have to load every user and
-- recompute every release on every tick. Instead it asks for the rows in a
-- narrow time window, which is one index scan regardless of how many users
-- exist.

create table if not exists public.due_entries (
  id bigserial primary key,
  user_id text not null references public.profiles (id) on delete cascade,
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  release_at timestamptz not null,
  class_at timestamptz not null,
  class_date date not null,
  release_note text,
  unique (subscription_id, release_at)
);

create index if not exists due_entries_release on public.due_entries (release_at);

-- ---------------------------------------------------------------------------
-- booking_history: what actually happened, for the UI
-- ---------------------------------------------------------------------------

create table if not exists public.booking_history (
  id bigserial primary key,
  user_id text not null references public.profiles (id) on delete cascade,
  -- Nulled rather than deleted when a subscription goes away: the attempt still
  -- happened, and losing that record would make a past failure unexplainable.
  subscription_id uuid references public.subscriptions (id) on delete set null,
  class_name text not null,
  class_date date not null,
  start_time text not null,
  outcome text not null,
  detail text,
  attempts integer not null default 1,
  first_attempt_offset_ms integer,
  dry_run boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists booking_history_user_time
  on public.booking_history (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Housekeeping: deleted Neon Auth users
-- ---------------------------------------------------------------------------
--
-- Deleting an account in Neon Auth cannot cascade into these tables, because
-- point 1 above rules out the foreign key that would carry the cascade. Neon
-- Auth soft-deletes instead, setting `deleted_at` in its mirror, so the orphans
-- are findable. Run this occasionally, or never — it is a few rows either way:
--
--   delete from public.profiles p
--   where not exists (
--     select 1 from neon_auth.users_sync u
--     where u.id = p.id and u.deleted_at is null
--   );
--
-- The cascades above then clear that user's subscriptions, schedule and
-- history. Check what it would remove before running it: a profile whose user
-- has not yet appeared in the mirror looks identical to a deleted one.
