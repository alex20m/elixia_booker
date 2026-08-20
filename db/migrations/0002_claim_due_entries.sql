-- ---------------------------------------------------------------------------
-- due_entries: turn claimDue from a read into a claim
-- ---------------------------------------------------------------------------
--
-- Until now `claimDue` was a plain select: any caller asking "what's due right
-- now" got the same rows as any other. That was fine while exactly one
-- scheduler ever called it. It stops being fine once a second one does — the
-- high-precision watcher introduced alongside this column calls the same
-- endpoint the per-minute safety-net cron does, and the two can legitimately
-- see the same release within seconds of each other. `claimed_at` lets
-- `claimDue` hand a release to only the first caller; see CLAIM_LEASE_MS in
-- lib/db/repo.ts for why a claim expires rather than being permanent.

alter table public.due_entries add column if not exists claimed_at timestamptz;

-- Every claim check filters on "unclaimed (or expired)", so the index is
-- partial: claimed rows never need to be in it.
create index if not exists due_entries_unclaimed_release
  on public.due_entries (release_at)
  where claimed_at is null;
