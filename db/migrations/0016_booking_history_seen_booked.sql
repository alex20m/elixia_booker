-- When Elixia last confirmed the user was still booked into this class.
--
-- The calendar feed keeps a class that has already run (lib/calendarFeed.ts),
-- which is only honest about classes it actually confirmed. Elixia publishes
-- its schedule from today forward, so once a class is over there is nothing
-- left to ask: an unbooking nobody observed while the class was still
-- upcoming can never be observed afterwards. Without this column the absence
-- of `cancelled_at` was read as attendance, which conflates "she went" with
-- "nobody ever looked".
--
-- Nullable, and deliberately not backfilled: a row with no value here is one
-- whose booking was never confirmed, which is exactly what the feed needs to
-- know about rows written before this existed.

alter table public.booking_history
  add column if not exists last_seen_booked_at timestamptz;
