-- subscriptions: who is currently running the class
-- ---------------------------------------------------------------------------
--
-- Elixia's schedule listing carries an instructor per class occurrence, and
-- who that is changes week to week — the same class slot is not the same
-- instructor forever. This column holds the last one a nightly job
-- (app/api/cron/instructors) actually saw, so the dashboard can show it
-- without reading the ~1.5MB schedule page on every request.
--
-- Nullable, with no default: unset until the first refresh finds a name, and
-- left as whatever it last was on a night the class cannot be read — a
-- refresh failure must not blank out a name that was true a day ago.

alter table public.subscriptions
  add column if not exists instructor_name text;
