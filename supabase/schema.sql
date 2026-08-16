-- Elixia Booker schema.
--
-- Run this once in the Supabase SQL editor (see SETUP.md). It is idempotent, so
-- re-running it after a change is safe.
--
-- Two principles shape it:
--
--  1. Row-level security enforces per-user isolation in the *database*, not just
--     in application code. Even a routing bug that hands the wrong user id to a
--     query cannot return another person's rows, because the policy checks the
--     JWT rather than the parameter.
--
--  2. Foreign keys cascade. Deleting a subscription deletes its scheduled
--     bookings, so a removed class cannot leave behind a pointer that the cron
--     might still act on.

-- ---------------------------------------------------------------------------
-- profiles: one row per Supabase auth user
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
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
  user_id uuid not null references public.profiles (id) on delete cascade,
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
  user_id uuid not null references public.profiles (id) on delete cascade,
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
  user_id uuid not null references public.profiles (id) on delete cascade,
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
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The cron uses the service-role key, which bypasses RLS by design. Every
-- browser-facing query goes through the anon key plus the user's JWT and is
-- therefore constrained by these policies.

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.due_entries enable row level security;
alter table public.booking_history enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Read-only from the browser: due entries are derived data, written only by the
-- server when subscriptions change or the nightly reindex runs.
drop policy if exists "own due entries" on public.due_entries;
create policy "own due entries" on public.due_entries
  for select using (auth.uid() = user_id);

drop policy if exists "own history" on public.booking_history;
create policy "own history" on public.booking_history
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Create a profile automatically for every new auth user
-- ---------------------------------------------------------------------------
--
-- Doing this in a trigger rather than in application code means a user can
-- never end up authenticated but profile-less, which would make every
-- subsequent query fail in a confusing way.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
