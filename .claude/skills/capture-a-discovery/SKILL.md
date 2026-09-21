---
name: capture-a-discovery
description: >-
  Land something you just worked out where the next project will find it — the
  repo you learned it in, and the skeleton every new app is copied from. Use
  whenever a task cost you a non-obvious discovery: a provider CLI that fails
  quietly, a version that has to be pinned exactly, an ordering that matters, a
  trap whose symptom points somewhere other than its cause, or an API surface
  you verified against a primary source. Covers deciding whether it is a
  standing rule or a skill, telling a general discovery that belongs in the
  skeleton from a repo-specific one that must stay local, keeping copies from
  drifting apart, and why the skeleton is not optional for anything general.
---

# Capture a discovery

Sessions here do not share memory. Anything not written down is discovered
fresh every time — differently each time — and that is precisely how the same
mistake gets made twice in three repos.

The rule is short: **when you learn something that is not already in `CLAUDE.md`
or a skill, land it in the repo you learned it in — and, if another project could
act on it, in the skeleton too, in the same task.** Not "later", not "if it comes
up again". The second time is the occasion you will not recognise.

Two questions, in this order, and they are independent:

1. **Is it worth capturing at all?** → *Is it a discovery worth capturing?*, below.
2. **Is it general, or only true of this app?** → *Where it goes*, below.

Getting the second one wrong in either direction costs something. Keeping a
general discovery local means every other repo rediscovers it the hard way.
Pushing a local one to the skeleton is not the safe default it looks like: the
skeleton is read by projects that know nothing about the app it came from, so an
app-specific rule there reads as a general one, and the reader has no way to tell
it does not apply to them.

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

Two independent choices: what **form** it takes, and how far it **travels**.

**Form** — is there a procedure around it?

| What you learned | Where it belongs |
| --- | --- |
| A one-line standing rule, no procedure | `CLAUDE.md` |
| A procedure: order, checks, traps, decision rules | A skill |
| A shape a new app should *start* with, not just know | Code, plus one of the above |

That last row is the one people skip. If the discovery changes what good code
looks like — a module that must not import a framework helper so it stays
testable, a build command that has to be ordered — then documenting it is half
the job. The code should already *be* that shape, so the next reader inherits it
without reading anything.

**Reach** — apply the generality test: *would a different app, built on this
stack but doing something else entirely, act on this?*

| | Lands in |
| --- | --- |
| **General** — true of the stack, the tooling, the providers, the platform | This repo **and** the skeleton |
| **Repo-specific** — true only of this app | This repo only |

Some things that look local are general once you name the mechanism. "Our
checkout page 500s because the migration ran after the deploy" is about this app;
"a migration in a workflow cannot be ordered against a deploy the platform owns"
is about every app on the stack, and that is the version the skeleton wants. When
a discovery has both halves, split it: the mechanism travels, the incident stays.

Genuinely repo-specific findings are not homeless — they belong in that repo's
`README.md`, `SETUP.md`, its own `CLAUDE.md`, or a skill that lives only there.
Write them down with the same care. They just do not get copied outward.

If you cannot decide, ask what a reader of the skeleton would do with it. If the
honest answer is "check whether it applies to them", it is repo-specific: the
skeleton is read by people with no context on where a line came from, and a rule
they have to litigate is worse than one that was never there.

**Improve an existing skill rather than adding a near-duplicate.** A new
situation that is a variation on something already covered is an edit to that
skill. A new skill is for a procedure nothing covers.

## Landing it in both places

For a general discovery. A repo-specific one stops at step 1.

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

## Why the skeleton, for anything general

A repo learns something for itself. The skeleton is the only place a *future*
project reads, because it is what gets copied. A general discovery landed only in
the repo that found it protects one codebase; landed in the skeleton it protects
every app that starts after today — which is the whole reason the skeleton
exists.

That reason is also the limit. The skeleton is a starting point, and every line
in it is a line the next project pays to read and takes on trust. App-specific
rules dilute it: they cost attention, they invite cargo-culting a constraint that
was never general, and enough of them turn the skeleton from a starting point
into a pile to be sorted. Keeping it general is not tidiness — it is what makes
the copied-from-here promise worth anything.

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
- **Never record an absence your sample could not have produced.** "No such
  response exists", "that field is never set", "this error cannot happen" — the
  strongest-sounding lines in a write-up are usually the ones nothing actually
  tested. A capture only rules a case out if the capture could have *reached*
  it, and the way this goes wrong is compound: a second, unrelated mistake in
  the same document removes the path to the case, so its absence reads as
  proof. Both errors then hold each other up and neither ever surfaces as a
  contradiction, because nothing in the system disagrees with itself. Before
  writing down that something does not exist, say how you would have made it
  happen. If you cannot answer, that is the finding — write "unobserved, and
  here is what would produce it" instead, which is a sentence someone can act
  on rather than one they will trust.
- **Say what your sample could not have distinguished.** A fact read off one
  account, one tenant, one plan or one environment records whatever was true
  *there* — and where two different rules would have produced the same
  observation, a single sample cannot tell you which one you saw. Two
  thresholds that coincide on the account you captured with (a plan limit that
  happens to equal the system default, a publication horizon that happens to
  equal that tier's entitlement) read as one boundary, and the write-up
  confidently names the wrong cause. It is a nasty one because nothing later
  looks like evidence: the code, the docs and every subsequent capture on the
  same account all agree, and the mistake only surfaces when someone on a
  different plan says "but I can see more than that". So when a finding rests
  on a threshold, name the account or plan it came from, and say which rival
  explanation the sample could not rule out. One line is enough, and it turns
  a future contradiction from a mystery into a confirmation.
