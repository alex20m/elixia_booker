---
name: attach-a-repo
description: >-
  Pull a GitHub repo the session was not started with into scope, so it can be
  read, cloned, edited and opened as a PR against — instead of reporting "I
  don't have access". Use whenever a task needs a repo not in the session's
  Repository Scope: a sibling repo, the app skeleton, a repo the user only
  mentions in passing. Covers why that repo looking unreachable is usually a
  false negative, the add_repo → clone → register_repo_root sequence and its
  timeout/concurrency traps, and why a repo can be safely reused instead of
  reflexively deleted.
---

# A repo outside scope is not a repo you lack access to

A session starts with a fixed Repository Scope — the list of repos the GitHub
tools can already reach. It is a **snapshot from session start**, not the
limit of what the account can reach. Any other repo the user has access to —
a sibling app, the shared skeleton, anything `list_repos` can see — can be
pulled in mid-session. Reporting "I don't have access to that repo" without
having tried is very often just wrong.

## The false negative that causes this

Two habits produce a confident wrong answer:

1. **Reading the Repository Scope list as exhaustive and permanent.** It
   lists what is attached *right now*; it says nothing about what is
   attachable. Seeing a repo missing from it is not evidence the repo is
   unreachable — it is evidence nobody has attached it yet.
2. **Pre-checking with `curl`, `git ls-remote`, or `gh repo view` before
   trying to attach it.** An unauthenticated request to a private repo
   returns 404 whether or not the account can reach it — GitHub does not
   distinguish "doesn't exist" from "you're not who you claim to be" for an
   anonymous caller. That 404 looks exactly like "no access" and is not: it
   is the wrong tool, used pre-emptively, giving a wrong answer with total
   confidence. **Do not pre-check. Call the attach tool directly** and let it
   perform the real, authenticated reachability check.

If the repo genuinely is not authorized, the attach tool says so — with the
actual reason (not enabled for this workspace, GitHub App not installed) and
the concrete remedy (an org admin grants access; the user reconnects GitHub
under Settings → Connectors). That is the one case where "I don't have
access" is the right thing to tell the user — and it is worth relaying that
reason verbatim rather than a generic "can't reach it."

## Finding the tools

The repo-attach tools live on a session-management MCP server. Its stable
name is `claude-code-remote`, but the prefix a given session actually sees on
its tool names can instead be a connection-specific identifier (a UUID-like
string) rather than that stable alias — this varies by session and is not
worth memorizing. **Find the tools by keyword rather than hardcoding a
prefix:**

```
ToolSearch({ query: "add_repo", max_results: 5 })
ToolSearch({ query: "list_repos register_repo_root", max_results: 5 })
```

The three that matter here: `list_repos` (discover / confirm spelling),
`add_repo` (attach), `register_repo_root` (tell the session the clone is
ready to read).

## The procedure

### 1. Confirm the name, if it's not exact

```
list_repos({ query: "<substring>" })
```

Case-insensitive substring match against `owner/repo`. Skip this if you
already have the exact `owner`/`repo`.

### 2. Attach it

```
add_repo({ owner: "<owner>", repo: "<repo>", access: "push" | "read" })
```

Use `"push"` when the task will commit, branch, or open a PR against the
repo — including via the GitHub API tools, not just git. Use `"read"` (the
default) for a repo you only need to consult. A repo attached read-only and
later found to need a push is just `add_repo` called again with `"push"`.

The result is not just a confirmation — it is a long, specific instruction
block for the next step, generated for the situation your session is
actually in (path collisions, concurrency limits, timeouts). **Follow that
block's instructions, not just the summary below**, since it can carry
detail specific to the moment (e.g. how many repos are already attached)
that a static skill can't anticipate.

### 3. Clone it — inline, once, with room to breathe

```bash
git clone --depth 1 https://github.com/<owner>/<repo> <path>
```

- **Do this yourself, in the current turn.** Not a subagent, not in parallel
  with another clone. The session's git proxy caps concurrent smart-HTTP
  operations low (observed at 2 for one repo) — a second concurrent clone
  gets both operations 429'd rather than queued.
- **Give it a generous timeout** — several minutes, not a tool's default
  couple of minutes. A large repo's shallow pack can take a while to unpack
  through the proxy. `index-pack` can look stalled while it works through a
  big pack; that is normal. Don't interrupt, kill, or re-run a clone that is
  still making progress.
- **On a 429** ("too many concurrent git operations"): that is this
  session's own local concurrency cap, not a GitHub rate limit. Sleep the
  suggested `Retry-After` (or ~10s) and retry **once** — not in a loop, and
  not by spawning more workers to race it.
- **Shallow is the default and usually enough.** Run `git fetch --unshallow`
  afterward only if the task genuinely needs full history (blame, log,
  bisect).

### 4. If the target path already exists, don't reach for `rm -rf`

Check what's actually there before touching it:

```bash
git -C <path> rev-parse HEAD   # succeeds → it's a finished clone, just use it
```

If that fails:

- Sample `du -sh <path>/.git` a couple of times, ~15s apart. Growing → a
  clone (yours from a retry, or another turn's) is in progress — wait.
- Static for ~60s **and** `ls -A <path>` shows nothing but `.git` → it's a
  dead half-clone. Safe to `rm -rf` and retry the clone once.
- `ls -A <path>` shows anything else → **stop.** That path is occupied by
  something that is not a dead clone. Do not delete it; tell the user the
  path is taken.

### 5. Register the root

Once `rev-parse HEAD` succeeds against the clone:

```
register_repo_root({ owner: "<owner>", repo: "<repo>", directory: "<absolute clone path>" })
```

This loads the repo's own `CLAUDE.md`, skills, and plugins into context —
**as a system-reminder on the next turn**, not by you reading the file.
Don't `Read` its `CLAUDE.md` yourself; let it arrive that way. If
`register_repo_root` is denied or errors, fall back to reading `CLAUDE.md`
directly instead of skipping repo-specific instructions entirely.

## What attaching actually unlocks

Both of these become usable against the newly attached repo, immediately:

- **Direct filesystem/git access** at the cloned path — read, edit, commit,
  push, branch, like any other local checkout.
- **The GitHub API tools** (opening/reading/merging PRs, issues, etc.)
  against that `owner/repo` — confirmed working in practice, not just in
  theory: opening and squash-merging a PR against a repo attached this way,
  mid-session, works the same as it does for a repo the session started
  with.

The Repository Scope text printed in the system prompt will not visually
update to list the new repo — it says as much itself ("this list is a
snapshot from session start"). That's cosmetic. The tools work regardless;
don't let the stale-looking text talk you out of trying them.

What this does **not** widen: repos nobody has attached stay out of reach,
and broad, repo-argument-less search/list tools stay scoped to what the
system prompt says they're scoped to. Attaching is per-repo and additive,
never a blanket grant.

## The takeaway

"Not in Repository Scope" is a starting condition to fix, not a verdict to
report. Try `add_repo` before telling the user a repo is unreachable — the
common case is that it works.
