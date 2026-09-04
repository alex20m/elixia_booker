---
name: deploy-gate
description: >-
  Build a CI/CD workflow whose gates are themselves tested, so a deploy can
  never outrun the checks. Use when adding or changing a pipeline that both
  verifies and deploys, when a deploy needs credentials the repo may not have,
  and when writing tests that assert on workflow configuration. Covers what to
  assert about a pipeline, the vacuous-detector trap those tests fall into, and
  why deploying has to degrade to a skip rather than a failure.
---

# Testing the pipeline, not just with it

A workflow file is the one piece of config that decides what reaches
production. In a repo where nothing is reviewed by a human, its shape is
behaviour: dropping `npm test` from the check job, or dropping the `needs:` that
makes the deploy wait for it, produces a pipeline that is green and worthless.
Nothing else in the suite notices, because every other test runs *inside* the
job that was just bypassed.

So assert on the workflow the way you assert on code: parse it and check the
guarantees.

## What is worth asserting

Only claims with a plausible bad edit behind them. For each one, name the edit
that turns it red — if there isn't one, it is decoration.

- **Every deploy job depends on the check job.** The single most valuable
  assertion: it is what stops an untested commit shipping.
- **Production promotion is narrow.** The production job runs only on the event
  and ref you intend, and it is the *only* job passing the promote flag
  (`--prod`, `--env production`, whatever the platform calls it). A preview job
  that gains that flag silently overwrites the live site.
- **The install is lockfile-exact.** `npm ci`, not `npm install`, or the checks
  are not testing the tree that deploys.
- **A deploy is never cancelled mid-flight.** Concurrency for deploy jobs must
  queue, not cancel; an interrupted deploy can leave a half-promoted build.
- **The deploy is smoke-tested.** A build that succeeds can still boot into a
  500 — a missing environment variable is the usual cause — so the job should
  request a real endpoint afterwards and fail on a bad answer.

Skip anything that merely restates the file (job names, runner images, step
ordering for its own sake). Those turn the test into a copy of the config, so
every legitimate edit is a test edit.

## The trap: detectors that match nothing

The natural way to write these tests is to find the deploy jobs by what they
run, then loop over them. If the detector matches zero jobs, **every loop body
passes vacuously** and the suite is bright green while asserting nothing. This
is easy to hit — a regex for `vercel deploy` does not match
`npx vercel@latest deploy`.

Two defences, use both:

1. **Assert the detector found something** (`expect(ids.length).toBeGreaterThan(0)`)
   as its own test, so an empty match is a failure rather than a silence.
2. **Look up jobs through a helper that throws** on an unknown id, instead of
   indexing the map directly. A renamed job then fails loudly with the list of
   ids that do exist, rather than reading as `undefined`.

Then prove the whole set: break the workflow on purpose — remove the `needs:`,
add the promote flag to the preview job — run the tests, confirm the specific
reds, and restore. A gate assertion you have not seen fail is exactly the thing
this skill exists to prevent.

## Parsing gotcha

Under YAML 1.1 the `on:` key parses as the boolean `true`; under YAML 1.2 it
stays the string `"on"`. Modern parsers default to 1.2, but check which you have
before concluding the trigger block is missing.

## Deploying must degrade to a skip

The deploy needs credentials that a fork's pull request cannot see and that a
fresh clone of the repo will not have. If missing credentials fail the job, the
pipeline is red for reasons no contributor can fix, and people learn to ignore
it.

Have the job read the secrets in a first step, write a `configured=true|false`
output, and guard the deploy steps on it — emitting a notice explaining what to
set when it skips. Checks still run; deploying is opt-in.

Two details that bite:

- **Secrets cannot be evaluated in a job-level `if:`.** The check has to happen
  in a step, which is why the pattern is a step output rather than a condition
  on the job.
- **Prefer the stable alias over the one-off deployment URL** for the smoke
  test. Fresh deployment URLs often sit behind access protection and answer 401
  to an anonymous request, which reads as a broken deploy.

## Before adding a deploy workflow at all

Check whether the hosting platform's own git integration is already deploying
on push. Both enabled means every merge deploys twice, racing each other — so
there is one route to production, and on Vercel it is the platform's, always.

That leaves CI two jobs, and everything above still applies to them:

- **The checks workflow** on every pull request and push. It gates merging
  rather than deploying, so what protects production is the branch's required
  check, not a `needs:` — assert that the workflow runs the full set
  (lockfile-exact install, lint, typecheck, test, build), because a check
  quietly dropped from it is the same failure this skill exists to catch.
- **A deploy-adjacent workflow**, where one is needed — usually migrations.
  It is not a deploy, but it touches production, so the credential-degrades-to-
  a-skip pattern and the smoke test still apply, and it must be safe to re-run:
  the platform's deploy is not waiting for it.
