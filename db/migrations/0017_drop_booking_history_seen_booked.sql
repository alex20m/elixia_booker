-- Drops `last_seen_booked_at`, added one migration ago in 0016.
--
-- It gated whether a class that had already run stayed on the calendar feed:
-- kept only if Elixia had confirmed the booking still held. The intent was to
-- avoid claiming attendance nobody had checked, but it solved a problem that
-- was not the one being reported, at the cost of dropping past classes whose
-- booking simply predates the column. A class in the past now stays, full
-- stop (lib/calendarFeed.ts).
--
-- Dropped rather than left unread: a column nothing writes and nothing reads
-- is one the next reader has to work out the irrelevance of.

alter table public.booking_history
  drop column if exists last_seen_booked_at;
