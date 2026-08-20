---
name: capture-a-discovery
description: >-
  Land something you just worked out where the next project will find it — the
  repo you learned it in, and the skeleton every new app is copied from. Use
  whenever a task cost you a non-obvious discovery: a provider CLI that fails
  quietly, a version that has to be pinned exactly, an ordering that matters, a
  trap whose symptom points somewhere other than its cause, or an API surface
  you verified against a primary source. Covers deciding whether it is a
  standing rule or a skill, keeping copies from drifting apart, and why the
  skeleton is not optional.
---

# Capture a discovery

Sessions here do not share memory. Anything not written down is discovered
fresh every time — differently each time — and that is precisely how the same
mistake gets made twice in three repos.

The rule is short: **when you learn something that is not already in `CLAUDE.md`
or a skill, land it in the repo you learned it in *and* in the skeleton, in the
same task.** Not "later", not "if it comes up again". The second time is the
occasion you will not recognise.

## Is it a discovery worth capturing?

Ask what the next agent would do without it. If the answer is "the same thing,
a bit slower", it is not worth capturing. If the answer is "the wrong thing, and
not notice", it is.

Worth capturing:

- **A trap whose symptom points elsewhere.** A CLI that silently creates the
  wrong resource, a config that fails the build rather than the request, a
  proxied DNS record that presents as a TLS error.
- **A version or flag that has to be exactly right**, especially where the
  wrong one produces a confusing error rather than a clear one.
- **An ordering that matters** — where doing two things in the other order
  half-works, which is worse than failing.
- **A decision rule** you had to reason out and would have to reason out again.
- **A surface you verified against a primary source**, with the version you
  verified it at. That is the part that decays, and recording it is what lets
  the next reader tell "wrong" from "moved".

Not worth capturing: a single command with no procedure around it, a fact
specific to today's data, or a preference with no steps. Those go in the repo's
own docs, or nowhere.

## Where it goes

| What you learned | Where it belongs |
| --- | --- |
| A one-line standing rule, no procedure | `CLAUDE.md` |
| A procedure: order, checks, traps, decision rules | A skill |
| Something true only of this app | That repo's `README.md` / `SETUP.md` |
| A shape a new app should *start* with, not just know | The skeleton's code, plus the above |

That last row is the one people skip. If the discovery changes what good code
looks like — a module that must not import a framework helper so it stays
testable, a build command that has to be ordered — then documenting it is half
the job. The skeleton should already *be* that shape, so the next project
inherits it without reading anything.

**Improve an existing skill rather than adding a near-duplicate.** A new
situation that is a variation on something already covered is an edit to that
skill. A new skill is for a procedure nothing covers.

## Landing it in both places

1. **Write it once**, in whichever repo you are in.
2. **Copy the file** to the skeleton and to any sibling repo carrying the same
   skill. Copy it — never retype it, and never "apply the same edit by hand" in
   the second repo. Retyped copies drift by a word at a time until they are two
   different rules with one name.
3. **Diff every copy before you commit**, and expect byte-identical:

   ```bash
   diff -q <repo>/.claude/skills/<name>/SKILL.md <skeleton>/.claude/skills/<name>/SKILL.md
   ```

4. **One PR per repo**, each one saying what was learned and where else it
   landed, so a reviewer of either can tell the set is complete.

If a sibling repo's copy has already drifted, reconcile it in the same task
rather than adding your change on top of a divergence — otherwise the next
person to copy has to guess which version was right.

## Why the skeleton always

A repo learns something for itself. The skeleton is the only place a *future*
project reads, because it is what gets copied. A discovery landed only in the
repo that found it protects one codebase; landed in the skeleton it protects
every app that starts after today — which is the whole reason the skeleton
exists.

The skeleton is also where a discovery gets *tested* rather than just asserted:
if the thing you learned can be encoded as a check that fails when it is
violated, put that check in the skeleton's suite. A rule with a test behind it
survives contact with someone who has not read the rule.

## What to write

The standards from `CLAUDE.md` apply — mechanism not anecdote, repo-agnostic,
and say what you are unsure about. Two additions that matter for discoveries
specifically:

- **Record what you verified it against**, with a version and a date, when the
  fact could move: a package version, a CLI version, an API surface. "Verified
  against X@1.2.3, published <date>" tells the next reader whether to trust it
  or re-check it.
- **Name the wrong path you took**, briefly, when the wrong path is the
  attractive one. "Pinning v7 from memory typechecks as an unknown property" is
  worth a sentence, because that is the mistake the reader is about to make.
