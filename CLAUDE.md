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

## New App Projects: Stack Defaults

These are the defaults for a **new project that is an app**. They are not a
mandate to rewrite an existing one — a project already built on another stack
keeps it until there is a reason of its own to move.

- **Next.js, in TypeScript.** No new JavaScript-only app code.
- **Hosted on Vercel.**
- **Neon for Postgres**, when the app needs a database — and only then. Add it
  as a **Vercel Marketplace integration**, not as a separate Neon account wired
  up by hand, so the connection details arrive as Vercel-managed environment
  variables and stay in sync when they rotate.
- **Neon Auth for accounts**, when Neon is already the database and the app
  needs sign-in. Today's Neon Auth is **managed Better Auth**: identity lives in
  the `neon_auth` schema of your own database, so users are queryable in SQL and
  a database branch carries its own users. It is *not* the older Stack Auth
  integration (`@stackframe/stack`, the `NEXT_PUBLIC_STACK_*` variables) — that
  one is closed to new projects, and most tutorials still describe it.
- **A different auth provider is a fine choice** when it suits the app better —
  Neon Auth is the default, not a requirement. Decide deliberately, say why in
  `SETUP.md`, and set it up by CLI like everything else.
- **Custom domains come from Cloudflare**, with DNS records pointed at Vercel
  and the proxy (orange cloud) **off**.
- **Deploys come from Vercel's own Git integration** — always. Every push gets a
  preview, every merge to `main` goes to production, and no workflow of ours
  does the deploying. Two routes to production race each other and deploy
  everything twice.
- **CI/CD exists from the first commit**, as at most two workflows — one for
  pull requests, one for pushes to `main` — each running the same checks:
  install from the lockfile, lint, typecheck, test, build. Nothing merges
  without it. Neither deploys, and neither migrates. (A workflow for the app's
  own scheduled work is a separate thing and does not count against this.)
- **Database migrations run in the deploy's build command, never in a
  workflow.** A migration workflow cannot be ordered against a deploy the
  platform owns: both start from the same push, so new code can be serving
  requests against a schema that has not been migrated yet. Putting the
  migration inside the build makes the ordering a dependency instead — Vercel
  promotes a deployment only if its build exited 0, so a failed migration
  leaves the previous deployment serving. Set it in `vercel.json`, which also
  overrides a Build Command set in the dashboard:

  ```json
  { "buildCommand": "npm run migrate && next build" }
  ```

  **`&&`, never `;`** — a semicolon builds straight over a failed migration,
  which is the exact failure this arrangement exists to prevent. Keep the
  migration out of the plain `build` script, or the checks need a database too.
- **Use the migration tool's own CLI** — `node-pg-migrate` for Postgres,
  `supabase db push` where Supabase owns the schema — and not a hand-written
  runner: ledgers, checksums and locking are solved problems, and a bespoke one
  is code nobody reviews and everything depends on. The same preference holds
  generally — reach for the maintained package before writing the mechanism
  yourself.
- **Old code still meets the new schema**, because the migration runs while the
  previous deployment is still serving, so **every migration must be compatible
  with the code already running**: add, backfill, and only remove in a later
  change. Two costs that come with this and should be stated in `SETUP.md`: a
  deploy now needs the database reachable to succeed, and rolling a deployment
  back does not roll the schema back.
- **Anything else the app genuinely needs is fair game** — pick it deliberately,
  and document its setup along with the rest.

### Every app project ships a `SETUP.md`

Not optional, and not a summary: it is the setup, written so that **someone
holding the tokens — or an agent — can run it top to bottom without opening a
browser.** Keep it current in the same MR as any change that alters setup.

### CLI over dashboard, always

Every step that can be a command must be a command: a provider CLI subcommand
first, the provider's REST API with `curl` and a scoped token second, and the
dashboard only where a provider genuinely gates the step on a human (minting
the first token, billing, accepting terms). Collect those few in one "has to be
done by hand" section of `SETUP.md` so the manual surface stays visible and
keeps shrinking.

**Use the `cli-first-provisioning` skill** for how to do this — the order the
pieces have to be created in, driving the provider CLIs non-interactively, the
traps that fail quietly (variables that need a redeploy, proxied DNS records,
auth redirect domains), and what `SETUP.md` must contain. **Use the `deploy-gate`
skill** for the workflows themselves — what to assert about a pipeline so its
gates cannot be silently removed.

---

## Write Down What You Worked Out

If you figure out how to do something that the next task would otherwise have to
figure out again, capture it as a skill in `.claude/skills/<name>/SKILL.md`
instead of leaving it in a transcript nobody will read. Sessions here do not
share memory: an approach that is not written down is discovered fresh every
time, differently each time, and that is exactly how the same mistake gets made
twice.

**Anything a project discovers that is not already in this file or in a skill
goes to two places, in the same task: this repo, and `app_skeleton`.** The
skeleton is what every new app is copied from, so it is the only place a
*future* project reads — a discovery landed only where it was found protects one
codebase, and landed in the skeleton it protects every app that starts after
today. Where the discovery changes what good code looks like rather than only
what to know, change the skeleton's code too, so the next project starts in that
shape without having to read anything.

**Use the `capture-a-discovery` skill** for how: deciding whether it is a
standing rule here or a procedure in a skill, copying rather than retyping so
the copies cannot drift, diffing them before you commit, and what to record
about a fact that can move (the version you verified it against, and the
attractive wrong path).

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
- **Add it to `app_skeleton` always**, and to any sibling repo carrying the same
  skill, keeping every copy byte-identical so they cannot drift.

Existing skills follow this: `merge-on-green`, `test-first`,
`isolated-task-branch`, `cli-first-provisioning`, `deploy-gate`,
`capture-a-discovery`. Improve one rather than writing a near-duplicate — if a
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
