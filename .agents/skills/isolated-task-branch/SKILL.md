---
name: isolated-task-branch
description: >-
  Set up and tear down an isolated branch or worktree for one task, so parallel
  tasks never collide and no checkout is left locked. Use when starting any piece
  of work that will become its own PR, when several tasks may be in flight at
  once, when picking a branch name, when returning to a task whose PR already
  merged, and when cleaning up afterwards. Covers collision checks before you
  create anything, keeping runtime state per-task, rebasing early, and the
  difference between a shared checkout and a fresh clone.
---

# One task, one branch, one PR

The goal is that any task can be inspected, abandoned, or rebased without
disturbing another, and that the repo is never left in a state where switching
branches errors out or a stale checkout shadows real work.

Everything here follows from one rule: **never share a branch, a worktree, or a
running dev server between two tasks** — not even "quick" ones. Shared state is
what turns two independent tasks into one tangled diff that neither can ship.

## First, work out what isolation you already have

The mechanics differ depending on where you are running, and reaching for a
worktree you do not need is its own kind of mess.

- **A fresh clone per session** (a container, a CI runner, a cloud dev
  environment) is already isolated. One branch in that checkout is enough — a
  worktree adds a directory to manage and buys nothing, because nothing else is
  using the checkout.
- **A shared, long-lived checkout** — your own machine, several tasks in flight —
  is where worktrees earn their keep. Each task gets its own directory, so
  switching between them is `cd`, not `git checkout`, and no task can leave
  another's files half-swapped.

Check before assuming: if `git worktree list` shows a single entry and the clone
was made for this session, you are in the first case.

## Before creating anything, check for collisions

Two parallel tasks that pick the same branch name or the same directory will
fight, and the failure shows up much later as a confusing rebase.

```bash
git fetch origin
git worktree list                 # directories already in use
git branch -a                     # local and remote-tracking branches
git ls-remote --heads origin      # branches that exist only on the remote
```

The last one matters: a branch pushed by another session will not appear in
`git branch -a` until you fetch, and colliding with it is discovered at push
time.

**Derive the name from the task**, not from the kind of work: `fix/login-redirect-404`
or `feat/csv-export`, never `fix`, `update`, or `claude/patch`. Two tasks
described properly cannot collide by accident; two tasks named `fix` always will.

## Start from fresh origin/<default>

Always branch from a just-fetched default branch, so parallel tasks share a base
and do not inherit each other's in-progress work.

```bash
git fetch origin
git checkout -B <branch-name> origin/<default-branch>     # single checkout
git worktree add ../<task-name> -b <branch-name> origin/<default-branch>   # shared checkout
```

Branching from whatever happened to be checked out is how one task's unfinished
commits end up inside another task's PR.

## Keep runtime state per task

This is the part that bites hardest and is easiest to forget: the git isolation
is worthless if two tasks share a runtime.

- **Its own dependency install.** Two directories on different branches can need
  different lockfile states; a shared `node_modules` (or equivalent) silently
  gives one task the other's dependencies.
- **Its own port and its own env file.** Never point two working directories at
  one running dev server. The symptom is brutal to debug: you test a change and
  see the *other* task's behaviour, because the server you are hitting is
  serving the other checkout.
- **Its own database or namespace** where the work touches persistent state.

If the project has a per-task setup script, run it inside the new directory
rather than reusing whatever is already running.

## Rebase early and often

```bash
git fetch origin
git rebase origin/<default-branch>
```

Do this periodically while the task is open, not only at the end. Parallel tasks
touch shared files, and conflicts are cheap to resolve one at a time and
expensive to resolve all at once. Keeping the diff small and scoped is the same
insight from the other direction: **do not bundle unrelated fixes into one
branch**, however tempting while you are in the file.

## Finishing

Push the branch and open the PR from it. Once it has merged:

- **Tear down from the main checkout, never from inside the worktree** — removing
  the directory you are standing in leaves git confused:

```bash
git worktree remove ../<task-name>
git worktree prune
```

- **Do not delete the remote branch by hand** if the host is configured to delete
  merged branches automatically. Let it.
- **Sweep periodically.** `git worktree list` will accumulate directories from
  abandoned or finished tasks; those paths stay claimed until pruned, and a later
  task that picks the same name will fail to create its worktree.

## Follow-up work after a PR has merged

A merged PR is finished. It cannot track new work, and stacking commits on the
already-merged branch produces a second PR whose diff contains the first one's
history.

Start again from the current default branch — reusing the same branch name is
fine:

```bash
git fetch origin
git checkout -B <branch-name> origin/<default-branch>     # single checkout
git worktree add ../<task-name>-followup <branch-name>    # shared checkout
```

Then open a **new** PR. If the branch still carries unmerged commits beyond what
landed, keep them: rebase them onto the new base rather than discarding them.
