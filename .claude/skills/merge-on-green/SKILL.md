---
name: merge-on-green
description: >-
  Watch an open pull request's CI through to completion and merge it the moment
  it is genuinely green. Use this whenever a task's changes still need to land on
  the default branch — right after pushing a branch or opening a PR/MR, and any
  time the request involves waiting for CI, checking the pipeline, "is the build
  done", "merge it when it's green", or babysitting/monitoring a PR. Use it even
  for what sounds like a one-off status check, because *how* you read the status
  is exactly what goes wrong. Runs as a background subagent so the wait doesn't
  consume the calling conversation's context. Invoke with args, in order:
  `<owner> <repo> <pull_number> <branch> [worktree_path]`.
context: fork
agent: general-purpose
arguments: [owner, repo, pull_number, branch, worktree_path]
---

# Merge on green

Take an open PR from *pushed* to *merged*, without ever merging code CI has not
actually vetted. This runs in its own background subagent (no access to the
conversation that invoked it) precisely so a wait of several minutes to several
hours never re-sends a growing transcript turn after turn — it costs the calling
session one tool call, and the result lands there when this finishes.

## Setup

You were given `$owner $repo $pull_number $branch`, and optionally
`$worktree_path`. If `$worktree_path` is non-empty, `cd` into it first — every
git command below assumes you are inside the checkout for `$branch`.

If any of `$owner $repo $pull_number $branch` is blank, derive it before
proceeding: `owner`/`repo` from `git remote get-url origin`; `branch` from
`git branch --show-current`; `pull_number` from the host's PR-listing API
filtered to that branch. Do not guess — an unresolved argument means stop and
report why, rather than operating on the wrong PR.

## The one trap

Ask GitHub for a PR's checks seconds after opening it and you get a short list —
fast external integrations, deploy previews — all passed, nothing pending. That
reads as green and is worthless: **checks are created over time, not all at
once.** A job gated behind `needs:` gets no check run until its dependency
succeeds; a workflow no runner has picked up yet reports nothing at all; and a
check that doesn't exist yet is indistinguishable from one that will never
exist. So "everything I can see has passed" is trivially true in the window
before the real work starts, and merging there ships code CI never looked at.

The rule is not "wait for the checks I can see." It is "wait until GitHub says
the commit is mergeable and passing, having given it long enough to know."

## What green means

Read `mergeable_state` on the PR — GitHub's own rollup over every check run and
commit status on the head commit. Don't reconstruct it from the check list.

| `mergeable_state` | Meaning | Merge? |
|---|---|---|
| `clean` | Mergeable; everything attached to the head commit completed and passed | **Yes** |
| `unstable` | Mergeable, but something is pending or concluded badly | No — wait, or investigate |
| `blocked` | A required check is pending/failing, or a review is required | No |
| `dirty` | Conflicts with the base branch | No — rebase, resolve, push |
| `behind` | Base moved and strict required checks are on | No — update the branch |
| `unknown` | GitHub hasn't finished computing it | Re-poll; not a verdict |

`clean` is the only value to merge on, and it's strict — a *failed* check makes
the state `unstable`, same as a pending one. An `unstable` that never resolves
is your cue to read the check list and find out which.

This field is what makes the loop portable: external services (deploy previews,
coverage bots) report against the commit and roll up into it automatically, with
no YAML to parse and no list to maintain. Anchor every reading to the **current
head SHA** — a green result for code you've since replaced says nothing.

## Before merging: two mechanical checks

```bash
git status --porcelain          # must be empty — no uncommitted work
git log origin/<branch>..HEAD   # must be empty — nothing unpushed
```

Either non-empty means `$branch` doesn't yet contain the work CI is validating.
Fix that (commit/push) before trusting anything green.

## The loop

### 1. Anchor to the head SHA

```
mcp__github__pull_request_read({method: "get", owner: $owner, repo: $repo, pullNumber: $pull_number})
```

Record `head.sha`; confirm `state: "open"` and `draft: false`. If that SHA ever
changes, the evidence is void and the clock restarts here.

### 2. Wait before looking

Looking early teaches you nothing, so spend the time asleep, not polling.
Estimate the pipeline's duration from the repo's own history (`get_check_runs`
on a recently merged PR reports `started_at`/`completed_at` per job); default
to **3 minutes, then every 2** when there's nothing to measure. Longer for
suites with browser/container steps.

```
Bash({command: "sleep 180", run_in_background: true, description: "wait before first CI check"})
```

then end the turn — being backgrounded, this subagent is simply resumed when
the sleep exits, at no cost to the conversation that invoked it. For waits
beyond ~10 minutes, `mcp__Claude_Code_Remote__send_later` survives restarts.
Foreground `sleep` and back-to-back polling calls both burn turns for nothing.

### 3. Poll one field

```
mcp__github__pull_request_read({method: "get", owner: $owner, repo: $repo, pullNumber: $pull_number})
```

Read `mergeable_state`, confirm `head.sha` is unchanged. Anything but `clean` →
wait and repeat. Reach for the check list only to explain a non-`clean` state —
a long `unstable` you suspect is a real failure, or one you're about to debug:

```
mcp__github__pull_request_read({method: "get_check_runs", owner: $owner, repo: $repo, pullNumber: $pull_number})
mcp__github__pull_request_read({method: "get_status",     owner: $owner, repo: $repo, pullNumber: $pull_number})
```

Read both — Actions jobs are check runs, many external services post commit
statuses, and a combined status of `success` can be true while every Actions
job is still running. `skipped` is a pass (conditional jobs, unconfigured
integrations). `cancelled` reads like a pass and isn't — a killed run produced
no verdict; re-run it or push a fix.

**Expect these reads to lag,** sometimes by minutes — a check can show
`in_progress` long after it finished. Before concluding anything is stuck,
compare the eventual `completed_at` to the wall clock and re-poll once; don't
cancel or start debugging a "hang" off one stale-looking read.

### 4. What the field can't tell you

`mergeable_state` rolls up checks that **exist** — it can't predict ones still
to be created. A repo with no CI reports `clean` immediately and permanently,
which is the same answer it gives seconds after a push, before anything exists.
It is also officially undocumented and can go briefly stale — the best signal
available, not a contract. What it does track reliably: one Actions job merely
running is enough to hold the state at `unstable`.

The blind spot is narrow (PR-open to first check run existing has measured at
five-to-six seconds; the step-2 floor clears that by two orders of magnitude),
but two cases still deserve an explicit look before you trust a `clean`:

- **`clean` with no checks at all, minutes after the push.** Confirm with one
  `get_check_runs` whether CI just doesn't run here, or nothing triggered —
  both are fine to merge on, but know which.
- **Workflows chained via `on: workflow_run`.** A second run is only created
  after the first finishes, so a brief `clean` can appear between them. If the
  repo has any, confirm with `mcp__github__actions_list({method:
  "list_workflow_runs", owner: $owner, repo: $repo, workflow_runs_filter:
  {branch: $branch}})`, keeping entries whose `head_sha` matches yours and
  requiring every `status` to be `completed`.

### 5. On failure, fix the cause

```
mcp__github__get_job_logs({owner: $owner, repo: $repo, run_id, failed_only: true, return_content: true, tail_lines: 200})
```

(`run_id` is in the failing check's `html_url`.) Fix the underlying problem,
reproducing locally where you can. Never reach green by weakening an assertion,
skipping a test, or re-running a job until it passes — a flake re-run away is a
bug shipped, and where the suite is the only review, nothing else catches it.
After pushing, the clock and evidence reset: back to step 1 with the new SHA.

### 6. Check freshness against the default branch

A `clean` head proves its own checks passed, not that the default branch has
stood still — GitHub only reports `behind` for that when branches are required
to be up to date, which most repos don't turn on. Check explicitly:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo up-to-date || echo behind
```

- **Behind** → rebase onto `origin/main`, resolve conflicts, push, and restart
  at step 1 with the new SHA. Old evidence doesn't carry over a rebase, and a
  `main` that moved once can move again while you wait out the re-run.
- **Up to date** → merge.

### 7. Merge

Reconfirm: PR still open, `head.sha` still matches what you validated, working
tree clean, nothing unpushed. Then:

```
mcp__github__merge_pull_request({
  owner: $owner, repo: $repo, pullNumber: $pull_number,
  merge_method: "squash",
  commit_title: "<PR title> (#<number>)",
  commit_message: "<one-line summary>"
})
```

Verify rather than assume: re-read the PR and confirm `merged_at` is set (a 405
means GitHub refused — re-check `mergeable_state` instead of retrying).
`list_pull_requests` reports `merged: false` even for merged PRs; trust
`merged_at` from `pull_request_read`.

## Report back

This is a forked subagent — its return value is the only thing the calling
conversation sees. Make it one line it can relay straight to the user:

- `MERGED $owner/$repo#$pull_number: <what changed, one line>`
- `BLOCKED $owner/$repo#$pull_number: <what's failing and what you did about
  it — fixed and re-queued, or needs a human decision>`

Never end without one of these. An unmerged PR with no report is a task no one
knows is still open.

## Do not

- **Merge on "everything I can see has passed."** That's the trap this skill
  exists to close.
- **Trust a `clean` read seconds after pushing** — at that point no checks
  exist yet to roll up.
- **Rebuild the verdict from the check list** when `mergeable_state` already
  aggregates it — reach for the list to explain a state, not to determine one.
- **Use GitHub auto-merge in a repo with no required checks** — it merges as
  soon as it can, which is this same bug with less visibility. Where required
  checks exist, it's the right answer (below), not a shortcut.
- **Merge while the branch is still being edited.** Green on a commit you've
  since moved past is not permission to land it.
- **Skip the step-6 freshness check because `mergeable_state` said `clean`** —
  that's a different question from whether `main` has moved, unless the repo
  requires branches to be up to date.

## How to delete the floor: require the checks

The floor exists because, without required status checks, "will another check
appear on this commit?" is undecidable — any GitHub App can create one at any
moment, and GitHub can't report a check nobody has created yet.

Declaring required status checks (Settings → Branches → *Require status checks
to pass before merging*, one entry per job) closes that question: an expected
check that hasn't reported yet reads `blocked`, not `clean`, so there's no
instant where an unfinished commit looks mergeable. In that repo, poll
immediately, or better, call `mcp__github__enable_pr_auto_merge` with
`mergeMethod: "SQUASH"` and let GitHub merge the moment required checks pass —
this still doesn't cover step 6 unless the branch-protection rule also requires
being up to date. One trap: a required check whose workflow gets skipped by
path/branch filtering never reports, and the PR blocks forever — only require
checks that run unconditionally on every PR.

Until a repo is configured this way, keep the floor.
