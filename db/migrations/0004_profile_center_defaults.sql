-- ---------------------------------------------------------------------------
-- profiles: remember where a user last chose a class from
-- ---------------------------------------------------------------------------
--
-- The chooser now narrows a group-wide list of clubs by country, then city,
-- then centre. That is three choices before the one that matters, and all
-- three are the same every week for anyone who trains at their own gym — so
-- the last choice is kept and offered back next time.
--
-- Only the place is stored. The class is the decision being made, and a
-- prefilled one is a subscription nobody meant to create.
--
-- Nullable with no default, because "never chosen" is a real state the chooser
-- has to render differently from any particular country. Adding columns is
-- also what keeps this compatible with the deployment still serving while the
-- migration runs (see 0003): the old code neither reads nor writes them.
--
-- `default_center` holds Elixia's numeric club id when the centre was picked
-- from the list, and the typed name when it was named by hand — the same two
-- spellings a subscription's `center` may carry, for the same reason.

alter table public.profiles
  add column if not exists default_country text,
  add column if not exists default_city text,
  add column if not exists default_center text;
