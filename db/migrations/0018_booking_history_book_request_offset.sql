-- When the booking request itself went out, relative to the release instant.
--
-- `first_attempt_offset_ms` is stamped before the class is looked up, so it
-- records how accurately the run woke, not when Elixia was asked. Everything
-- between the two — the schedule fetch that resolves the class id, its parse,
-- any rounds spent waiting for the class to be listed — is time other people
-- are using to book, and it was invisible: two runs a second apart both
-- reported the same single-digit offset.
--
-- Nullable twice over: rows written before this column existed carry no value,
-- and a run whose class never listed sent no request at all.

alter table public.booking_history
  add column if not exists book_request_offset_ms integer;
