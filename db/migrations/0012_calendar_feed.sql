-- Calendar sync: a per-user secret feed a calendar app can subscribe to.
--
-- The token is stored in plain text, not hashed. Unlike the Telegram link
-- token (lib/telegramLink.ts), this one is not a one-time bearer credential
-- presented once and consumed — a calendar app re-fetches the same URL
-- indefinitely, and the settings page has to be able to show it again later
-- so it can be copied a second time. A hash-only store would make that
-- impossible without rotating the link. It is a capability URL, the same
-- trust level as a shared calendar's "secret address in iCal format".

alter table public.profiles
  add column if not exists calendar_sync_enabled boolean not null default false,
  add column if not exists calendar_feed_token text;

-- Partial: most profiles never generate one, and null <> null would let the
-- index sit there doing nothing anyway.
create unique index if not exists profiles_calendar_feed_token
  on public.profiles (calendar_feed_token)
  where calendar_feed_token is not null;

-- The centre a booking happened at, so the calendar event can carry a
-- location. Nullable: rows written before this migration have none, and
-- `to_char`-style backfill is not worth it for a cosmetic field.
alter table public.booking_history
  add column if not exists center text;
