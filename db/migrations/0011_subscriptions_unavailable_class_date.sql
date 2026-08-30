-- ---------------------------------------------------------------------------
-- subscriptions: record when the *next* occurrence is confirmed absent
-- ---------------------------------------------------------------------------
--
-- unlisted_since (0004) catches a class Elixia has withdrawn altogether: the
-- weekly slot itself no longer appears anywhere in the published schedule.
-- Some Elixia classes are one-off, though — present most weeks and simply
-- missing for one date, with the weekly slot itself never going anywhere —
-- and that case sails straight past the general check, since the slot still
-- shows up on some other date in the window. It would otherwise only surface
-- at T-0, indistinguishable there from a booking window that has not opened
-- yet (docs/api.md §4).
--
-- This column is the date-specific answer: the classDate of the soonest
-- upcoming occurrence a check most recently confirmed missing from a
-- *published* day, not merely a day that has not opened yet. It always names
-- the occurrence it was checked against, so as soon as that occurrence rolls
-- forward to the next date, a fresh check either clears it or refiles it
-- against the new date — nothing here outlives the occurrence it names.
--
-- Additive and nullable, so the deployment still serving while this runs is
-- unaffected: it neither selects nor writes this column. `if not exists` so a
-- re-run is not an error.

alter table public.subscriptions
  add column if not exists unavailable_class_date date;
