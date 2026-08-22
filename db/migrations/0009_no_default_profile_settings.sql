-- ---------------------------------------------------------------------------
-- profiles: stop inventing a membership, a city and a channel for people
-- ---------------------------------------------------------------------------
--
-- Three columns arrived with defaults, and each default is a claim the app was
-- making on the user's behalf and could not check:
--
--   * `booking_window_days` defaulted to 7. A Premium member books 14 days
--     ahead; with 7 stored, every attempt fires a week late for a class that
--     filled while they waited.
--   * `time_zone` defaulted to whatever the deployment's DEFAULT_TIMEZONE said.
--     A release instant is a wall-clock time in that zone, so a wrong one is
--     silently an hour or several out.
--   * `notify_channel` defaulted to 'email' (0008). Reasonable, and still a
--     choice nobody made — which is the same category of bug, just quieter.
--
-- None of the three announces itself when wrong: the app keeps running and the
-- classes keep not being booked. So they are asked for instead, on the setup
-- pages a new account cannot get past, and the columns lose their defaults.
--
-- `configured_at` is what marks those pages finished. It is a separate column
-- rather than an inference from the other three being non-null, because the
-- rows that already exist have values that came from the very defaults being
-- removed. Inference would read them as answers; a null `configured_at` reads
-- them for what they are — never chosen — and asks once. Nothing is erased in
-- the meantime, so an existing user sees their own answers stored the moment
-- they confirm them.
--
-- Compatibility with the deployment still serving while this runs (see
-- SETUP.md): dropping a default and a not-null constraint cannot break code
-- that writes every column explicitly, which is what lib/db/neonRepo.ts has
-- always done, and existing rows keep the values they have. A profile created
-- by the *new* code during the changeover would read back with nulls in the
-- old code — but new profiles come from new code, which is serving by then.

alter table public.profiles
  alter column booking_window_days drop default,
  alter column booking_window_days drop not null,
  alter column time_zone drop default,
  alter column time_zone drop not null,
  alter column notify_channel drop default,
  alter column notify_channel drop not null,
  add column if not exists configured_at timestamptz;
