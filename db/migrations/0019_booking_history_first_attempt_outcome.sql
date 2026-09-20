-- How the first attempt was refused, when the run went on to try again:
-- "too-early", "error 400", "unauthorized 403" and so on.
--
-- `attempts` alone says something went wrong N times and nothing about what,
-- and the difference matters: a 4xx from the booking call is the window not
-- quite open, while a 401 or 403 would be Elixia refusing the session
-- outright. Those want opposite responses, and without this the only way to
-- tell them apart is to be reading the platform's logs at the moment it
-- happens.
--
-- Null when the first attempt was also the last — a row repeating its own
-- outcome explains nothing — and on rows written before this column existed.

alter table public.booking_history
  add column if not exists first_attempt_outcome text;
