-- ---------------------------------------------------------------------------
-- profiles: drop default_country and default_city, which nothing means any more
-- ---------------------------------------------------------------------------
--
-- `0005` added three columns for a chooser that narrowed the club list by
-- country, then city, then centre. Only `default_center` survived: the
-- schedule page turns out to carry no club locations at all (docs/api.md §4),
-- so the two wider steps each offered a single meaningless option and were
-- removed. The columns have been unread and unwritten since that release.
--
-- Deliberately a *separate* migration from the code change that stopped using
-- them, and it must stay that way. Migrations run inside the Vercel build,
-- while the previous deployment is still serving — so a migration is executed
-- against the *old* code. Dropping these in the same deploy that stopped
-- naming them would have broken that still-serving deployment outright: its
-- profile SELECT listed both columns, and every authenticated request makes
-- that read. Splitting it means each migration is compatible with the code
-- already running, which is the whole reason the ordering rule exists — the
-- same lesson `0003` records.
--
-- `if exists` so re-running against a database that never had them is not an
-- error.

alter table public.profiles
  drop column if exists default_country,
  drop column if exists default_city;
