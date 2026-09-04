-- ---------------------------------------------------------------------------
-- profiles: remember why the last alert could not be delivered
-- ---------------------------------------------------------------------------
--
-- `sendEmail` and `notifyChat` (lib/email.ts, lib/notify.ts) are deliberately
-- best-effort — a notification failure must never fail the booking it is
-- reporting — so a send that is turned away before dialling out (no channel
-- chosen, the channel switched off, the deployment missing its key) is an
-- ordinary state the setup and settings banners already explain. What none of
-- that covers is a request that *did* go out and failed anyway: a revoked
-- Resend key, an unverified sender, a bot token Telegram no longer honours.
-- Until now that reason lived only in `console.log`, reachable solely by
-- reading server logs — which is how a booking can run cleanly for weeks
-- while every alert about it silently disappears.
--
-- These two columns are that reason, persisted the same way `elixia_status`
-- already persists "Elixia rejected the saved credentials": written on the
-- next attempted send that fails, cleared on the next one that succeeds, and
-- read back by the dashboard so the gap is visible without a log line.
--
-- Additive and nullable, so the deployment still serving while this runs is
-- unaffected: it neither selects nor writes these columns.

alter table public.profiles
  add column if not exists notify_failed_reason text,
  add column if not exists notify_failed_at timestamptz;
