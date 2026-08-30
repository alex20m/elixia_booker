---
name: merge-on-green
description: >-
  Watch an open pull request's CI through to completion and merge it the moment
  it is genuinely green. Use this whenever a task's changes still need to land on
  the default branch — right after pushing a branch or opening a PR/MR, and any
  time the request involves waiting for CI, checking the pipeline, "is the build
  done", "merge it when it's green", or babysitting/monitoring a PR. Use it even
  for what sounds like a one-off status check, because *how* you read the status
  is exactly what goes wrong. Defines what "green" actually means, how to wait
  without burning context, and how to merge and confirm it landed.
---

# Merge on green

Take an open PR from *pushed* to *merged*, without ever merging code that CI has
not actually vetted.

Wait for everything to finish, then merge. The whole difficulty is that GitHub
will happily tell you everything has finished when it has not yet started.

> **Tried and reverted: running this as `context: fork` in the background.**
> Forking the whole loop into an isolated subagent looks like the obvious fix
> for the context this skill burns during a long wait — the fork's own polling
> never touches the calling conversation. In testing it silently failed to
> come back: the forked subagent started a background sleep, yielded, and was
> never resumed — no error, no notification, just a PR that sat unmerged with
> nothing watching it. Whether that's specific to one execution environment or
> general is unconfirmed; until background-fork resumption is verified
> end-to-end (a real multi-minute CI wait, observed to actually resume and
> report back), keep this loop inline in the calling conversation as below. A
> silent no-op on a step that ends with an irreversible merge is worse than
> the context cost this would have saved.

## The one trap

Ask GitHub for a PR's checks a few seconds after opening it and you get a short
list — typically just the fast external integrations, deploy previews and the
like — every one of them passed. Nothing is pending. Nothing is failing.

That answer is worthless, because **checks are created over time, not all at
once.** A job gated behind `needs:` gets no check run until its dependency
succeeds. A workflow no runner has picked up yet reports nothing at all. And in
the API, a check that has not been created is indistinguishable from one that
will never exist. So "every check I can see has completed and passed" is
satisfied, trivially, in the window before the real work starts — and merging
there means merging code CI never looked at.

So the rule is not "wait for the checks I can see". It is "wait until GitHub says
the commit is mergeable and passing, having given it long enough to know."

## What green means

Read `mergeable_state` on the PR — GitHub's own rollup over every check run and
commit status on the head commit. Don't reconstruct it from the check list.

| `mergeable_state` | Meaning | Merge? |
|---|---|---|
| `clean` | Mergeable; everything attached to the head commit completed and passed | **Yes** |
| `unstable` | Mergeable, but something is still pending *or* concluded badly | No — keep waiting, or investigate |
| `blocked` | A required check is pending/failing, or a review is required | No |
| `dirty` | Conflicts with the base branch | No — rebase, resolve, push |
| `behind` | Base branch moved and strict required checks are on | No — update the branch |
| `unknown` | GitHub has not finished computing it | Re-poll; not a verdict |

`clean` is the only value you merge on, and it is strict: a *failed* check makes
the state `unstable` just as a pending one does. An `unstable` that never
resolves is your cue to read the check list and find out which of the two it is.

This field is what makes the skill portable: external services (deploy
previews, coverage bots) report against the commit and GitHub's rollup counts
them for free — no YAML to parse, no list to maintain. Anchor every reading to
the **current head SHA**; a green result for code you have since replaced says
nothing about what you are about to merge.

## Arm this only when the branch is finished

Merging is the one irreversible step here, and the loop runs asynchronously — a
wake-up lands whenever it lands, including in the middle of you editing the same
branch. Start it only when the work is genuinely done. Before every merge:

```bash
git status --porcelain          # must be empty — no uncommitted work
git log origin/<branch>..HEAD   # must be empty — nothing unpushed
```

Either one non-empty means the PR does not contain the work yet. If a wake-up
arrives while you are still working, **do not merge on it** — re-arm the wait
and let the new commits go through CI first.

## The loop

### 1. Anchor to the head SHA

```
mcp__github__pull_request_read({method: "get", owner, repo, pullNumber})
```

Record `head.sha`; confirm `state: "open"` and `draft: false`. If that SHA ever
changes, the evidence is void and the clock restarts (step 5).

### 2. Wait before looking

Looking early cannot teach you anything, so spend the time asleep rather than
polling. Estimate the pipeline's duration from the repo's own history
(`get_check_runs` on a recently merged PR reports `started_at`/`completed_at`
per job); default to **3 minutes, then every 2** when there is nothing to
measure. Expect longer for suites with browser or container steps.

Wait with a **background** `sleep`, then end the turn:

```
Bash({command: "sleep 180", run_in_background: true, description: "wait before first CI check"})
```

The session is re-invoked when it exits, so a wait costs one tool call and no
context. For waits beyond ~10 minutes, or where the session's container may be
recycled while idle, `mcp__Claude_Code_Remote__send_later({delay_minutes: N,
message: "..."})` survives restarts because it wakes this same, addressable
session rather than an ephemeral subagent — at one-minute granularity.

Two non-options: foreground `sleep` is blocked in some harnesses, and firing
tool calls back-to-back to pass time burns context while revealing nothing.

A PR-activity subscription, where available, is a fine way to hear about
failures sooner — but never a replacement for the loop. Success events and
pushes are documented to arrive late or not at all, so silence from it is not
evidence.

### 3. Poll one field

```
mcp__github__pull_request_read({method: "get", owner, repo, pullNumber})
```

Read `mergeable_state` and check `head.sha` still matches step 1's. Anything but
`clean` → wait and repeat. That is the whole poll.

You only need the check list when you want to know *why* it is not `clean` — a
long-running `unstable` that you suspect is a failure rather than a pending job,
or a failure you are about to debug:

```
mcp__github__pull_request_read({method: "get_check_runs", owner, repo, pullNumber})
mcp__github__pull_request_read({method: "get_status",     owner, repo, pullNumber})
```

Both, when you do reach for them. Actions jobs arrive as *check runs* while many
external services post *commit statuses*, so either one alone is half the
picture — a combined status of `success` is perfectly normal while every
Actions job is still running.

`skipped` is a pass; conditional jobs and unconfigured integrations skip
routinely. `cancelled` is the one that reads like a pass and is not — a killed
run produced no verdict, so re-run it or push a fix rather than counting it.

**Expect these reads to lag, sometimes by many minutes.** A check run can report
`in_progress` long after it actually finished. Before concluding anything is
wrong, check the job's `completed_at` against the wall clock and re-poll once —
don't re-run, cancel, or start debugging a "hang" off one stale-looking read.

### 4. Know what the field cannot tell you

`mergeable_state` is a rollup over the checks that **exist**. It does not
predict checks that are coming. A repo with no CI at all reports `clean`
immediately and permanently — the same answer it gives in the moments after a
push, before anything has been created. It is also officially **undocumented**
and can go briefly stale between consecutive calls — the best single signal
available, not a contract. What it does track well: an Actions job merely
running is enough to hold the state at `unstable`.

The blind spot is narrow — PR-open to first check run existing has measured at
five-to-six seconds, and the step-2 floor clears that by two orders of
magnitude — but two cases still deserve an explicit decision:

- **A `clean` PR with no checks at all, minutes after the push.** Confirm with
  one `get_check_runs` whether CI just doesn't run here, or nothing was
  triggered — both are fine reasons to merge, but know which.
- **Workflows that trigger other workflows** (`on: workflow_run`). A second run
  is created only after the first finishes, so a brief `clean` can appear
  between them. If the repo has any, confirm with `mcp__github__actions_list({
  method: "list_workflow_runs", owner, repo, workflow_runs_filter: {branch:
  "<head branch>"}})`, keeping entries whose `head_sha` matches yours and
  requiring every `status` to be `completed`.

Both are exceptions. The ordinary path is step 3 alone.

### 5. On failure, fix the cause

```
mcp__github__get_job_logs({owner, repo, run_id, failed_only: true, return_content: true, tail_lines: 200})
```

`run_id` is in the failing check's `html_url`
(`.../actions/runs/<run_id>/job/<job_id>`).

Fix the underlying problem, reproducing locally where you can. Never reach green
by weakening an assertion, skipping a test, or re-running a job until it passes
— a flake you re-ran away is a bug you shipped, and where the suite is the only
review, nothing else will catch it.

After pushing, **the clock and the evidence reset**: back to step 1 with the new
head SHA, and wait out the pipeline again.

### 6. Check freshness against the default branch

`mergeable_state: clean` proves the head commit's own checks passed — it does
not prove nothing new has landed on the default branch since. GitHub only
reports `behind` for that when the repo requires branches to be up to date
before merging (a stricter setting most repos don't turn on); without it, a PR
can sit `clean` while `main` has moved ahead, and squash-merging it produces a
merge nobody's CI ever ran against the code as it will actually land. Check
explicitly rather than inferring it:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo up-to-date || echo behind
```

- **Behind** → rebase onto `origin/main`, resolve any conflicts, push, and go
  back to step 1 with the new head SHA. Old evidence doesn't carry over a
  rebase, and a `main` that moved once can move again while you wait out the
  re-run — loop this as many times as it takes.
- **Up to date** → proceed to merge below.

### 7. Merge

Confirm the PR is still open, that the SHA you validated is still `head.sha`,
and that the working tree is clean with nothing unpushed. Then merge with the
method the repo's conventions call for — squash where each PR should collapse
to a single commit on the default branch:

```
mcp__github__merge_pull_request({
  owner, repo, pullNumber,
  merge_method: "squash",
  commit_title: "<PR title> (#<number>)",
  commit_message: "<one-line summary>"
})
```

Supplying `commit_title` and `commit_message` keeps history readable; the
default squash body is the concatenation of every "fix lint" commit on the
branch.

Verify rather than assume: re-read the PR and confirm `merged_at` is set. A 405
means GitHub refused — re-read `mergeable_state` for the reason instead of
retrying. Note that `list_pull_requests` reports `merged: false` even for
merged PRs, so trust `merged_at` from `pull_request_read`.

Report the outcome plainly: merged, or what is blocking it.

## Do not

- **Do not merge on "everything I can see has passed."** That is the trap this
  whole skill exists to close — the checks you can see are not the checks
  there will be.
- **Do not trust a `clean` you got seconds after pushing.** The field describes
  the checks that exist, and at that point none do.
- **Do not rebuild the verdict by hand from the check list** when
  `mergeable_state` already aggregates it. Reach for the list to explain a
  state, not to determine one.
- **Do not use auto-merge as a shortcut** *in a repo with no required checks* —
  GitHub's auto-merge waits only for checks branch protection marks required;
  with none configured it merges as soon as it can, which is this same bug with
  fewer chances to notice. Where required checks exist it is not a shortcut but
  the right answer — see below.
- **Do not merge while you are still working on the branch.** Green on a commit
  you have already moved past is not permission to land it.
- **Do not stop watching a PR you opened.** An unmerged PR left behind is an
  unfinished task, and no one else is coming to finish it.
- **Do not skip the step 6 freshness check because `mergeable_state` said
  `clean`.** `clean` means the head commit's own checks passed, not that `main`
  has stood still, unless the repo requires branches to be up to date.

## How to delete the floor: require the checks

The floor is a symptom of repository configuration, not a limitation you can
read your way around. Without required status checks, "will another check
appear on this commit?" is undecidable — any GitHub App may create a check run
at any moment, and GitHub cannot report one nobody has created yet.

Declaring required status checks turns that into a closed question: a required
check that hasn't reported *yet* reads `blocked`, not `clean`, so there is no
instant where an unfinished commit looks mergeable. Two things then change:

- **Poll immediately** — `blocked` covers the early window deterministically.
- **Better, stop polling.** `mcp__github__enable_pr_auto_merge` with
  `mergeMethod: "SQUASH"` hands the loop to GitHub, which merges exactly when
  required checks pass. This still doesn't cover step 6's freshness check
  unless the branch-protection rule also requires being up to date.

Setting it up is a repository setting: Settings → Branches (or Rules →
Rulesets) → protect the default branch → *Require status checks to pass before
merging*, then add each job name (names appear once they've run at least once).
One trap: a required check whose workflow is skipped by path/branch filtering
never reports, and the PR blocks forever — only require checks that run
unconditionally on every pull request.

Until a repo is configured this way, keep the floor.
