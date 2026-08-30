-- Tracks a booking found no longer held, so the calendar feed can stop
-- serving an event for it.
--
-- This app never cancels a booking itself (docs/api.md §5 notes an
-- `/api/unbook` endpoint exists but nothing here calls it), so a row only
-- gets this set when the nightly `reviewBookedOccurrences` sweep finds the
-- user has cancelled it through Elixia's own app or site.

alter table public.booking_history
  add column if not exists cancelled_at timestamptz;
