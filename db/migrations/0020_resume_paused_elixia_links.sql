-- Resume every Elixia link that a sign-in failure had paused.
--
-- The booking run used to mark a link 'expired' — and book nothing more for
-- that user until they re-linked — whenever signing in again failed, for any
-- reason. On 2026-11-12 a change on Elixia's side broke the app's sign-in, so
-- accounts with perfectly good passwords were paused. Booking no longer
-- pauses at all (lib/service.ts `prepareUser`): every booking is attempted and
-- reports its own failure. This brings back the accounts paused before that,
-- so nobody has to re-link.
--
-- Their upcoming due entries and QStash ticks were left in place by the pause,
-- so the next booking goes ahead as soon as this has run; the nightly reindex
-- picks them up again from tonight.
--
-- Nothing writes 'expired' any more, so this runs once in effect. Compatible
-- with the code still serving while it runs: that code reads the column the
-- same way, and at worst re-pauses a link in the seconds before the new
-- deployment is promoted.

update public.profiles
   set elixia_status = 'ok'
 where elixia_status = 'expired';
