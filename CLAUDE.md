# Claude Workflow Rules

Conventions used in this document:

- **MR** and **PR** mean the same thing — whatever the repo's host calls a
  merge/pull request.
- `main` means the repo's default branch; substitute the real name if it
  differs.
- `<task-name>` and `<branch-name>` are placeholders you derive per task.

---

## Core Principle

All work must be isolated, reproducible, and branch-based:

- Do not commit directly to `main`.
- Do all work in a dedicated branch/worktree.
- Keep changes scoped to one task — do not bundle unrelated fixes into the
  same branch.

Do not stop after planning. Start implementing immediately, and only ask if
blocked.

---

## Write Down What You Worked Out

If you figure out how to do something that the next task would otherwise have to
figure out again, capture it as a skill in `.claude/skills/<name>/SKILL.md`
instead of leaving it in a transcript nobody will read. Sessions here do not
share memory: an approach that is not written down is discovered fresh every
time, differently each time, and that is exactly how the same mistake gets made
twice.

Worth extracting when it has a **procedure** — an order that matters, a check
that is easy to skip, a trap with a non-obvious cause, a decision rule for
choosing between options. Not worth extracting when it is a single command, a
one-off specific to today's task, or a preference with no steps; a rule like that
belongs in this file, not in a skill.

To keep a skill worth having:

- **Write the mechanism, not the anecdote.** Explain *why* the procedure is
  shaped that way, so a reader can adapt it when the situation differs slightly.
  A skill that only pattern-matches one past incident breaks on the next one.
- **Keep it repo-agnostic.** No job names, no project-specific paths, no
  timings measured from one pipeline. Derive those at use time. The evidence for
  a rule belongs in the PR that introduced it; the skill is the procedure.
- **Say what you are unsure about.** A skill that marks its own soft spots gets
  corrected; one that states everything with equal confidence gets trusted where
  it should not be.
- **Add it to both repos** when it is general enough to apply to both, and keep
  the copies identical so they do not drift.

Existing skills follow this: `merge-on-green`, `test-first`,
`isolated-task-branch`. Improve one rather than writing a near-duplicate — if a
new situation is a variation on something already covered, extend that skill.

---

## Tests Are the Review — Test-Driven by Default

**Nobody reviews these PRs.** The test suite is the only thing standing between
a change and production, so it has to carry the weight a human reviewer normally
would. Treat every test as a claim about behavior that someone is relying on.

The rules below are the standard. **Use the `test-first` skill for how to meet
it** — the red-first loop, verifying a regression test against the bug rather
than the fix, and recognising tests that cannot fail.

### Write the test first

For new features, work test-first wherever the behavior can be stated before the
code exists:

1. Write a test that describes the behavior the feature is supposed to have.
2. Run it and **watch it fail** — for the right reason (a wrong value or a
   missing behavior, not an import error or a typo).
3. Write the implementation until it passes.
4. Only then clean up.

A test that has never been seen failing has not been shown to test anything.

### A failing test is a good outcome

A red test means the suite just caught something before a user did — that is the
system working. Never treat a failure as an obstacle to be silenced:

- **Never** loosen an assertion, delete a case, add a conditional skip, widen a
  matcher (`toBeDefined`, `toBeTruthy`, bare `not.toThrow`), or mock away the
  very thing under test just to get to green.
- **Diagnose first:** is the *code* wrong, or has the *intended behavior*
  genuinely changed? Fix the code by default. Only change a test when the
  behavior it encodes is deliberately no longer true — and say so explicitly in
  the commit message and the MR.
- **Never disable, `skip`, or `only`** your way past a failure. If a test is
  genuinely, temporarily unrunnable, that is a blocker to raise, not to hide.

### Every test must be able to fail

Each test must have a realistic mutation of the source that turns it red. Before
committing one, ask: *what bug would this catch?* If there is no answer, the test
is decoration — delete it or rewrite it into one that asserts real behavior.

Tests that assert nothing useful are worse than no test, because they buy false
confidence in a suite nobody is double-checking. Specifically avoid:

- asserting a component "renders" without checking anything it rendered;
- asserting on a mock's own return value, so the test only proves the mock works;
- assertions so loose that any non-crashing implementation satisfies them;
- duplicating the implementation's arithmetic in the expectation instead of
  writing the expected value out literally.

**Existing tests of this kind may be deleted or rewritten** — a test that cannot
fail is not protecting anything, and removing it is not a loss of coverage. Say
in the MR which ones you replaced and why.

### Cover behavior, not lines

- **Test the contract** — inputs, outputs, and observable side effects — not the
  internals. A refactor that keeps behavior identical should keep tests green.
- **Include the unhappy paths:** errors, empty and single-element collections,
  permission denials, offline/failed requests, boundaries (first/last element,
  DST/timezone edges, midnight, empty string, `null`).
- **Prefer what the user perceives** (visible text, roles, emitted requests)
  over implementation details (class names, internal state, call counts of
  incidental helpers).
- **Name the test after the behavior it guarantees**, so a failure is
  self-explanatory: `refuses to share edit access when the sharer only has view`.
- **Tests must not be flaky** — a test that passes or fails non-deterministically
  on unchanged code is broken; fix the timing, ordering, or shared-state
  dependency instead of re-running until it goes green.

New features are not finished until their tests exist and pass, and the suite
runs clean locally before pushing.

---

## Bug Fixes Always Get a Regression Test

Whenever a task fixes a bug, a crash, or any incorrect behavior, the fix is not
finished until it ships with a test that fails without the fix and passes with
it:

- **Reproduce the reported bug**, not just the code path around it. If the test
  still passes when you revert the fix, it is not a regression test — rewrite
  it.
- **Pick the level that actually catches it:** unit test for logic, integration
  test for wiring/data flow, UI test for rendering and interaction bugs.
- **Cover the edge case that caused it** — the specific input, state, timing, or
  boundary that triggered the bug (empty list, timezone/DST boundary, first/last
  item in a range, missing field, race on load, etc.).
- **Name it after the behavior**, e.g. `restores the draft when the editor
  reopens after a failed save`, so a future failure explains itself.
- **Do not delete or weaken an existing regression test** to make a change pass.
  If it legitimately no longer applies because the functionality changed, say so
  explicitly in the commit message and the MR description.

This applies to every fix, however small — a one-line fix still gets a test. The
only exception is a change with no observable behavior (pure formatting,
comments, renames); in that case state in the MR why no test was added.

---

## PR & Merge Policy (default: auto)

This is a standing, advance authorization for the harness's normal "confirm
before PR / confirm before merge" behavior. It applies unless the user says
otherwise for that specific task:

- **Always open an MR/PR** when a task's changes are pushed — do not wait to be
  asked.
- **Merge automatically once CI/the pipeline goes green** on that MR. Getting CI
  green **is** sufficient authorization to merge — do not stop and ask first.
- **Use the `merge-on-green` skill to do the waiting and merging.** Do not
  improvise a polling approach: "all the checks I can see have passed" is not
  the same as green here, and PRs have been merged before CI ever ran because of
  it. The skill defines what green means on this repo and how to wait for it.
- **Always squash merge.** Use the host's squash-merge option (e.g. "Squash and
  merge" on GitHub) so each MR collapses to a single commit on `main` — never a
  regular merge commit or a fast-forward/rebase merge, even if a task's own
  history has several small commits.
- **Do not delete the branch after merging.** Branch deletion is handled
  automatically by the host ("Automatically delete head branches" is enabled in
  the repo settings). Claude has no tool to delete remote branches anyway — do
  not attempt it manually.
- **Do not auto-merge a conflicted MR.** If the MR is not mergeable with `main`,
  leave it even when CI is green: rebase onto `origin/main`, resolve the
  conflicts in the same branch, then re-check CI before merging. If conflict
  resolution is non-trivial or changes intent, ask before proceeding instead of
  guessing.
- **This default can be suspended per-task** by an explicit instruction (e.g.
  "don't merge this one", "wait for review first"). Absent that, always auto-PR
  and auto-merge on green.
- **Scope:** this policy covers PR creation and merging only. It does not extend
  to other destructive/hard-to-reverse actions (force-push, history rewrites,
  deleting branches other than the task's own worktree branch, etc.) — those
  still follow normal confirm-first behavior.

---

## When the MR Is Merged, Report It Simply

Once the task's MR is merged, the deliverable in the chat is a **short, plain
summary of what was done**.

**Assume it is the only thing the user reads.** They will not open the MR, read
its description, or scroll back through the session. So anything they need in
order to understand what changed — or to decide something — has to be in the
summary itself. Never park it in the MR description and link to it.

That cuts both ways, and short does not mean incomplete:

- **Include** what changed and why, in plain terms; anything left undone or
  deliberately skipped; anything needing a decision or action from them; and
  anything likely to surprise them later.
- **Cut** the process — the investigation, the false starts, the reasoning, the
  tools used, the order things were done in. That belongs in the MR description
  and the commit messages, which are the record for whoever audits this later,
  not reading for the user.

**Start it with a `## Summary` header**, so it is unmistakable where the summary
begins and where anything preceding it ends. Without that marker the summary runs
together with whatever was said while working, and the one part meant to be read
stops being findable.

Below that header: a few sentences or a handful of bullets. It should need no
further headings of its own — if it does, it is too long, though if trimming
would drop something the user has to know, cut elsewhere.

---

## Parallel Workflow

Multiple tasks may be in flight at once (different agents/sessions, or the same
agent multitasking). **Use the `isolated-task-branch` skill** for the mechanics —
collision checks before creating anything, per-task runtime state, teardown, and
restarting after a merge. The rules to satisfy:

- **One task = one worktree = one branch = one MR.** Never share a worktree or
  branch across tasks, even "quick" ones.
- **Unique names.** Derive `<task-name>` / `<branch-name>` from the task itself
  (e.g. `fix/login-redirect-404`, `feat/csv-export`), not generic names like
  `fix` or `update`. Two parallel tasks must never produce the same worktree
  path or branch name.
- **Check before creating.** Run `git worktree list` and `git branch -a` first,
  so a new task doesn't collide with one already in progress.
- **Always branch from fresh `origin/main`.** Run `git fetch origin` right
  before creating the worktree, so parallel tasks start from the same up-to-date
  base and don't inherit each other's in-progress work.
- **Assume shared files may be touched by other in-flight tasks.** Keep diffs
  small and scoped so rebasing is cheap; rebase onto `origin/main` often (not
  just at the end) to surface conflicts early instead of in one large resolution
  at the end.
- **Isolate runtime state per worktree.** Each worktree gets its own dependency
  install and its own dev-server port/env file — never point two worktrees at
  the same running dev server, port, or local env file.
- **If a task's MR is already merged**, don't stack follow-up work on the old
  branch/worktree. Recreate the branch from the latest `origin/main` (same
  branch name is fine) and open a new MR — see
  [Follow-up changes later](#follow-up-changes-later).

---

## Worktrees

- Always use Git worktrees for any task.
- Create one worktree per feature/fix/task.
- Never reuse a worktree for unrelated work.
- Rebase new code on top of `origin/main`.
- At the end, create an MR to `main`.
- Remove the worktree when the task is finished.
- If changes are requested later, create a fresh worktree from the same branch.

**Goal:** the user should always be able to inspect, delete, or switch branches
without encountering "used by worktree" errors.

### Create worktree

```bash
git fetch origin
git worktree add ../<task-name> -b <branch-name> origin/main
```

### Commit conventions

- Write commit messages that explain *why*, not just what.
- Prefer several small, logical commits over one giant commit when a task
  naturally splits (e.g. "add migration" / "add API endpoint" / "add tests").
- Never amend or force-push commits that are already pushed and part of an open
  MR unless explicitly asked.

### Finish task

Before finishing work, verify tests and pipeline status:

- Add unit/integration/UI tests for new functionality — written first where
  possible, and each one seen failing before it passes. See
  [Tests Are the Review](#tests-are-the-review--test-driven-by-default) for the
  quality bar.
- If the task fixed a bug, add a regression test for it — see
  [Bug Fixes Always Get a Regression Test](#bug-fixes-always-get-a-regression-test).
  Verify it fails without the fix.
- Do not modify existing tests unless functionality changed. The one exception
  is a test that cannot fail under any realistic bug — rewrite or delete it, and
  say so in the MR.
- Run tests locally to confirm they pass. Never reach green by weakening a test,
  skipping it, or mocking out the behavior under test.

Rebase on top of `origin/main`:

```bash
git fetch origin
git rebase origin/main
```

Then commit and push:

```bash
git add -A
git commit -m "<message>"
git push -u origin <branch-name>
```

Open an MR from `<branch-name>` to `main` and wait for CI/CD to run.

- Follow the `merge-on-green` skill to watch the pipeline and merge. Do NOT
  remove the worktree or stop the agent until all checks pass.
- If CI fails, iterate in the same worktree/branch and re-run the pipeline.
- Once all checks are green, merge automatically — see
  [PR & Merge Policy](#pr--merge-policy-default-auto). Do not wait to be asked,
  unless the user said not to merge this particular task.

### Delete worktree

```bash
git worktree remove ../<task-name>
git worktree prune
```

Run this from the main repo, not from inside the worktree.

Periodically run `git worktree list` to spot stale/abandoned worktrees left over
from finished or dropped tasks, and clean them up so paths stay free for new
work.

### Follow-up changes later

```bash
git fetch origin
git worktree add ../<task-name>-followup <branch-name>
```

Use the same `<branch-name>` as before, but create a new worktree instead of
reopening the old one.

---

## Efficiency Rules

- Do NOT scan the entire repository.
- Only read files directly relevant to the task.
- Avoid repeated file reads.
- Ask before broad architectural exploration.
- Prefer targeted grep/search over repo summarization.
