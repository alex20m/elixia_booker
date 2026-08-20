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
the commit is mergeable and passing, having given it long enough to know". There
is no manifest to maintain and no workflow file to parse — just one field and one
floor on how early you trust it.

## What green means

Do not reconstruct this from the check list. GitHub already computes it, over
every check run *and* commit status attached to the head commit, and hands it to
you as one field: `mergeable_state` on the PR.

| `mergeable_state` | Meaning | Merge? |
|---|---|---|
| `clean` | Mergeable; everything attached to the head commit completed and passed | **Yes** |
| `unstable` | Mergeable, but something is still pending *or* concluded badly | No — keep waiting, or investigate |
| `blocked` | A required check is pending/failing, or a review is required | No |
| `dirty` | Conflicts with the base branch | No — rebase, resolve, push |
| `behind` | Base branch moved and strict required checks are on | No — update the branch |
| `unknown` | GitHub has not finished computing it | Re-poll; not a verdict |

`clean` is the only value you merge on, and it is strict: a *failed* check makes
the state `unstable` just as a pending one does. That is the right default — a
red deploy preview should stop you and make you look — but it means an `unstable`
state that never resolves is your cue to read the check list and find out which
of the two it is.

Reading this field rather than the check list is what makes the skill portable.
External services — deploy previews, coverage bots, preview-comment bots — never
appear in `.github/workflows/` and cannot be enumerated from the repo, but they
report against the commit, so GitHub's rollup counts them and you get them for
free. There is no list to maintain and no YAML to parse.

Anchor every reading to the **current head SHA**. A green result for code you
have since replaced says nothing about what you are about to merge.

## Arm this only when the branch is finished

Merging is the one irreversible step here, and the loop runs asynchronously — a
wake-up lands whenever it lands, including in the middle of you editing the same
branch. So start it only when the work is genuinely done: the change is complete,
the tests you intend to add exist, and you have no further commits planned.

Before every merge, two mechanical checks:

```bash
git status --porcelain          # must be empty — no uncommitted work
git log origin/<branch>..HEAD   # must be empty — nothing unpushed
```

Either one non-empty means the PR does not contain the work yet, and CI validated
something other than what you meant to ship.

If a wake-up arrives while you are still working — you went back to fix
something, a review landed, you thought of one more test — **do not merge on it.**
Re-arm the wait and let the new commits go through CI first. A merge that races
your own editing is the same class of mistake as merging before CI finishes: it
lands a state nobody vetted, and everything still in flight has to become a
second PR.

## The loop

### 1. Anchor to the head SHA

```
mcp__github__pull_request_read({method: "get", owner, repo, pullNumber})
```

Record `head.sha`; confirm `state: "open"` and `draft: false`. If that SHA ever
changes, the evidence is void and the clock restarts (step 5).

### 2. Wait before looking

Looking early cannot teach you anything, so spend the time asleep rather than
polling. Estimate the pipeline's duration from the repo's own history —
`get_check_runs` on a recently merged PR reports `started_at` and `completed_at`
per job — and default to **3 minutes, then every 2** when there is nothing to
measure. Expect longer for suites with browser or container steps.

Wait with a **background** `sleep`, then end the turn:

```
Bash({command: "sleep 180", run_in_background: true, description: "wait before first CI check"})
```

The session is re-invoked when it exits, so a wait costs one tool call and no
context. For waits beyond ~10 minutes, or where the container may be recycled,
`mcp__Claude_Code_Remote__send_later({delay_minutes: N, message: "..."})` survives
restarts, at one-minute granularity.

Two non-options: foreground `sleep` is blocked in some harnesses, and firing
tool calls back-to-back to pass time burns context while revealing nothing. A
`Monitor` poll loop that exits on a terminal state is a good fit *if* the shell
can reach the GitHub API — worth one call to check, since sandboxed environments
often proxy or block `api.github.com` and ship no `gh` CLI, leaving the MCP tools
as the only route.

A PR-activity subscription, where available, is a fine way to hear about failures
sooner — but never a replacement for the loop. Success events and pushes are
documented to arrive late or not at all, so silence from it is not evidence.

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
external services post *commit statuses*, so either one alone is half the picture
— a combined status of `success` is perfectly normal while every Actions job is
still running.

`skipped` is a pass; conditional jobs and unconfigured integrations skip
routinely. `cancelled` is the one that reads like a pass and is not — a killed
run produced no verdict, so re-run it or push a fix rather than counting it.

**Expect these reads to lag, sometimes by many minutes.** A check run can report
`in_progress`, and the job's own step list can show a step still running, long
after both actually finished — the completion timestamp you eventually get back
is earlier than the moment you asked. So a job that looks stuck is usually a
stale read, not a hung runner. Before concluding anything is wrong, check the
job's `completed_at` against the wall clock rather than against how long you
have been waiting, and re-poll once. Do not re-run a job, cancel it, or start
debugging a "hang" on the strength of one stale-looking read — and do not tell
the user something is stuck until a fresh read at a known time still says so.

### 4. Know what the field cannot tell you

`mergeable_state` is a rollup over the checks that **exist**. It does not predict
checks that are coming. A repo with no CI at all reports `clean` immediately and
permanently — correctly — and that is the same answer it gives in the moments
after a push, before anything has been created. So a `clean` obtained seconds
after pushing is not evidence of anything, however green it looks.

Two further reasons to keep it as your primary signal rather than your only one:
it is an officially **undocumented** field — GitHub staff have said so on the
record, and the GraphQL enum mirroring it has been seen returning values its own
documentation omits — and tools built on it report it going briefly stale or
inconsistent between consecutive calls. It is the best single signal available,
not a contract.

What it does track well, measured with every externally-reported check already
terminal so nothing else could explain the reading: an Actions job merely running
is enough to hold the state at `unstable`. The field follows CI progress on its
own — it is only the not-yet-created that it cannot see.

That blind spot is narrow. From a PR opening to its first Actions check run
existing was six seconds in one measurement and five in another. The floor in
step 2 clears it by two orders of magnitude, and by three minutes in any
transient disagreement has resolved too. That is the floor's job — do not drop it
on the grounds that the field looks authoritative. The way to remove it is
configuration, not a better reading of the API; see the last section.

Two cases still deserve an explicit decision rather than a silent merge:

- **A `clean` PR with no checks at all**, minutes after the push. Either CI does
  not run on pull requests here, or nothing was triggered. Both are fine reasons
  to merge — but confirm which, with one `get_check_runs`, instead of assuming.
- **Workflows that trigger other workflows** (`on: workflow_run`). A second run
  is created only after the first finishes, so a brief `clean` can appear between
  them. If the repo has any, confirm with
  `mcp__github__actions_list({method: "list_workflow_runs", owner, repo,
  workflow_runs_filter: {branch: "<head branch>"}})` — keep the entries whose
  `head_sha` matches yours and require every `status` to be `completed`. Read
  only `head_sha`, `status`, and `conclusion`; these objects are very large.

Both are exceptions. The ordinary path is step 3 alone.

### 5. On failure, fix the cause

```
mcp__github__get_job_logs({owner, repo, run_id, failed_only: true, return_content: true, tail_lines: 200})
```

`run_id` is in the failing check's `html_url` (`.../actions/runs/<run_id>/job/<job_id>`).

Fix the underlying problem, reproducing locally where you can. Never reach green
by weakening an assertion, skipping a test, or re-running a job until it passes —
a flake you re-ran away is a bug you shipped, and where the suite is the only
review, nothing else will catch it.

After pushing, **the clock and the evidence reset**: back to step 1 with the new
head SHA, and wait out the pipeline again.

### 6. Merge

Confirm the PR is still open, that the SHA you validated is still `head.sha`, and
that the working tree is clean with nothing unpushed. Then merge with the method
the repo's conventions call for — squash where each PR should collapse to a
single commit on the default branch:

```
mcp__github__merge_pull_request({
  owner, repo, pullNumber,
  merge_method: "squash",
  commit_title: "<PR title> (#<number>)",
  commit_message: "<one-line summary>"
})
```

Supplying `commit_title` and `commit_message` keeps history readable; the default
squash body is the concatenation of every "fix lint" commit on the branch.

Verify rather than assume: re-read the PR and confirm `merged_at` is set. A 405
means GitHub refused — re-read `mergeable_state` for the reason instead of
retrying. Note that `list_pull_requests` reports `merged: false` even for merged
PRs, so trust `merged_at` from `pull_request_read`.

Report the outcome plainly: merged, or what is blocking it.

## Do not

- **Do not merge on "everything I can see has passed."** That is the trap this
  whole skill exists to close — the checks you can see are not the checks there
  will be.
- **Do not trust a `clean` you got seconds after pushing.** The field describes
  the checks that exist, and at that point none do.
- **Do not rebuild the verdict by hand from the check list** when `mergeable_state`
  already aggregates it. Reach for the list to explain a state, not to determine
  one — and never read the combined status alone, which may carry only a deploy
  provider's entry and say `success` while the tests are mid-flight.
- **Do not use auto-merge as a shortcut** *in a repo with no required checks.*
  GitHub's auto-merge waits only for checks branch protection marks *required*;
  with none configured it merges as soon as it can, which is this same bug with
  fewer chances to notice. Where required checks exist it is not a shortcut but
  the right answer — see below.
- **Do not merge while you are still working on the branch.** Green on a commit
  you have already moved past is not permission to land it, and the merge cannot
  be taken back.
- **Do not stop watching a PR you opened.** An unmerged PR left behind is an
  unfinished task, and no one else is coming to finish it.

## How to delete the floor: require the checks

The floor is a symptom of repository configuration, not a limitation you can read
your way around. Without required status checks, the question it guards is
**undecidable**: "will another check appear on this commit?" has no answer,
because any GitHub App may create a check run at any moment and nothing declares
in advance that it intends to. GitHub cannot report a check nobody has created
yet. Time is the only bound available, which is why there is a floor.

Declaring required status checks turns that open question into a closed one. The
expected set is written down, so GitHub reports a required check that has not
reported *yet* as expected — the PR reads "Waiting for status to be reported" and
`mergeable_state` is `blocked`, not `clean`. There is then no instant at which a
commit with unfinished checks looks mergeable, and the window this skill spends a
floor to cover simply does not exist.

In a repo configured that way, two things change:

- **Poll immediately.** `blocked` covers the early window deterministically, so
  the floor becomes a pure efficiency choice rather than a correctness guard.
- **Better, stop polling.** `mcp__github__enable_pr_auto_merge` with
  `mergeMethod: "SQUASH"` hands the whole loop to GitHub, which merges exactly
  when the required checks pass. The warning against auto-merge above applies
  only to repos *without* required checks; with them it is the correct mechanism
  and this skill reduces to arming it once.

Setting it up is a repository setting, not something the API tools here can do:
Settings → Branches (or Rules → Rulesets) → protect the default branch → *Require
status checks to pass before merging*, then add each job name to gate. Names
appear in the picker once they have run at least once.

One failure mode to design around: a required check whose workflow is skipped by
path or branch filtering never reports at all, and the PR blocks forever. Only
require checks that run unconditionally on every pull request.

Until a repo is configured this way, keep the floor.
