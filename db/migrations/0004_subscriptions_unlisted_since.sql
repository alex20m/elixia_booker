-- ---------------------------------------------------------------------------
-- subscriptions: record when a class stopped appearing on Elixia's schedule
-- ---------------------------------------------------------------------------
--
-- A class Elixia withdraws leaves its subscription behind. Booking then fails
-- to resolve it at T-0 and reports `too-early` — which is also what a class
-- looks like before its window opens (docs/api.md §4) — so the owner sees
-- "Missed" every week with nothing saying the class is simply gone. The
-- nightly reindex now compares each enabled subscription against the published
-- timetable and stores the first moment it found the class absent here; the
-- dashboard reads it, and it is cleared as soon as the class is listed again.
--
-- Null means "listed, as far as the last successful check could tell". It is
-- deliberately not a boolean: "gone since Tuesday" is what makes the warning
-- actionable, and a class off for one holiday week reads very differently from
-- one gone for a month.
--
-- Additive and nullable, so the deployment still serving while this runs is
-- unaffected: it neither selects nor writes this column. `if not exists` so a
-- re-run is not an error.

alter table public.subscriptions
  add column if not exists unlisted_since timestamptz;
