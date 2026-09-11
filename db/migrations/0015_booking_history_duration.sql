-- How long the booked class actually runs, in minutes, read off Elixia's own
-- schedule page at booking time (`ScheduleEvent.metadata.duration`, docs/api.md
-- §4). Nullable: rows written before this column existed carry no value, and
-- the calendar feed (lib/calendarFeed.ts) falls back to a fixed default for
-- those rather than requiring a backfill.

alter table public.booking_history
  add column if not exists duration_min integer;
