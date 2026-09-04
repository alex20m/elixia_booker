---
name: external-scheduler
description: >-
  Fire work at an exact external instant without trusting a CI platform's cron
  to be there. Use whenever something must happen at a moment the app does not
  control — a booking window that opens, an auction that closes, a token that
  expires, a reminder that has to land on time — and whenever a scheduled job
  "just stopped running" with nothing in the logs. Covers why a dropped trigger
  leaves no failure to find, how to tell a delayed trigger from a dropped one,
  the properties a handler needs before an at-least-once scheduler is safe, and
  the unit mismatch that schedules work tens of thousands of years late without
  erroring.
---

# Scheduling against an instant you do not control

CI schedulers (GitHub Actions `schedule`, and most platform crons) are a
scheduling *feature* on a product that is not a scheduler. That is fine for
"run the nightly report sometime tonight" and unfit for "act at 09:00:00.000,
because at 09:00:00.400 the slot is gone."

## The failure that has no error

The dangerous mode is not lateness — it is a trigger that never fires at all.
GitHub documents `schedule` as droppable when load is high, and load peaks at
the top of every hour. A dropped trigger produces:

- no failed run,
- no queued run,
- no log line,
- no notification.

It is **absence**, and absence is invisible to every alert built on "tell me
when something fails". Monitoring the job's own success rate cannot see it,
because the job did not run to succeed or fail. This is why such an outage is
typically discovered by a user noticing the work did not happen, hours later.

**Diagnosing it.** Absence looks identical to "not scheduled yet", so establish
these in order before blaming the platform:

1. **List actual runs and compare against the cron's expected fire times.**
   Missing entries at three consecutive expected times is the signal — one
   missing entry is normal jitter.
2. **Check whether unrelated triggers on the same platform still work.** If
   push- or PR-triggered jobs ran fine throughout the same window, it is the
   scheduler, not a platform-wide outage.
3. **Check the platform's status page for the window.** Confirms it, but its
   absence does not refute it — a dropped trigger often is not incident-worthy.
4. **Only then** look at the workflow file. The instinct is to suspect your own
   cron expression first; if the job ran for weeks and then stopped without a
   config change, the expression is not the cause.

## Mitigations, in ascending order of actually fixing it

**Move off the top of the hour.** Minute 0 is the documented worst case, so any
other minute lowers the odds. Cheap, and worth doing regardless — but it lowers
a probability rather than removing a dependency. Do not stop here and call the
problem solved.

**Add a watchdog.** A second, more frequent job that checks whether the first
is alive and re-triggers it. Bounds the outage to the watchdog's own interval.
But note what it is: a scheduler watching a scheduler, on the same platform
whose scheduler is the thing that failed. It reduces exposure; it does not
remove the shared dependency.

**Hand the instant to something whose product is scheduling.** A message queue
with delayed delivery (QStash, EventBridge Scheduler, Cloud Tasks) or a durable
timer (Cloudflare Durable Object alarms). The job stops being "a process that
must already be running in order to notice" and becomes "an entry in a system
that will deliver it." This is the one that removes the dependency rather than
hedging it.

## Before adopting an at-least-once scheduler

Every such service delivers *at least* once — duplicates are normal, not
exceptional, and retries make them likelier precisely when things are already
going wrong. Check the handler has both properties **before** migrating:

- **Idempotent.** Two deliveries for one instant must do the work once. An
  atomic claim (`UPDATE ... WHERE unclaimed RETURNING`) is the usual shape.
- **Window-claiming rather than item-addressed.** If one invocation handles
  everything due in a window, messages dedupe by *instant* rather than by item,
  which collapses N users' work into one delivery and makes the whole schedule
  cheap.

Where both hold, at-least-once costs nothing and the migration is mostly
plumbing. Where they do not, fix that first — an at-least-once scheduler on a
non-idempotent handler is a double-booking generator.

## Design the schedule to be republished, not tracked

The tempting design stores each message's id so it can be cancelled when the
underlying item changes. That is bookkeeping that can drift out of sync with
the thing it describes.

Prefer: **derive a deduplication id from the instant itself, and republish
everything upcoming on every reindex.** The scheduler discards the repeats. No
ids are stored, nothing is cancelled, and a message whose work has since been
removed simply finds nothing due and returns. The schedule becomes a pure
function of current state, recomputed rather than maintained.

Check the deduplication window (QStash: 90 days) exceeds your scheduling
horizon, or repeats stop being free.

## Traps

- **Seconds vs milliseconds.** Most of these APIs take a unix timestamp in
  *seconds* (QStash's `notBefore` does). Application code usually carries
  milliseconds. Passing ms where s is expected is accepted without error and
  schedules the work roughly fifty thousand years out — no exception, no
  rejected request, just a delivery that never comes. Assert on the unit in a
  test; it is invisible in review.
- **Partial configuration.** A token but no callback origin, or an origin but
  no auth secret, produces messages that fail *at delivery time* — hours later,
  on a path nobody is watching, retrying into a dead-letter queue. Refuse to
  operate unless every part is present, so the failure is at startup and the
  fallback is the old mechanism.
- **Authenticating the callback.** The scheduler calls a public URL. Reuse the
  endpoint's existing shared-secret guard by attaching the header to the
  message rather than adding signature verification as a second mechanism —
  fewer ways to be misconfigured. (Signature verification is the better choice
  when the endpoint has no guard yet.)
- **A per-message quota can reject the whole batch.** Publishing the horizon in
  one batched request is right, but a batch is usually validated as a *unit*:
  one message the provider refuses takes every other message in the request
  down with it, including the imminent ones. The commonest refusal is a
  delivery scheduled further out than the plan's maximum delay, so the horizon
  you *compute* must never exceed the horizon you can *enqueue* — clamp the
  publish window to the provider's ceiling and let the periodic republish pick
  up the rest as it comes into range. Keep a margin under the ceiling: the
  delay is fixed when you build the batch but measured when the provider
  receives it, so a message computed at exactly the limit arrives just past it.
  The symptom is the dangerous part — not a partial schedule but an empty one,
  reported as a quota error that names the quota rather than the message, on a
  publish path whose failure you have probably made non-fatal.
- **Verify a plan limit by probing, not by remembering.** These limits are
  per-plan, get renamed between doc revisions, and are the sort of thing a
  previous incident leaves you with a confident wrong memory of. Publishing a
  deliberately over-limit probe message returns the real ceiling in the error
  text, in one call, against the account that actually matters — and a
  companion in-range message in the same batch tells you whether refusals are
  per-message or per-batch. Delete the probes afterwards.
- **An implicit timeout is the provider's number, not yours.** Left unset, the
  connection timeout is "the maximum this plan allows" — nobody chose it and it
  moves when the plan does. Set it explicitly, sized to whichever ceiling bites
  *first*. For a handler that deliberately holds its connection open, that is
  usually the serverless platform's own max duration, which is typically far
  below the scheduler's: check both before assuming the scheduler is the one
  cutting you off, because an unexplained mid-flight death looks identical
  either way.
- **Scheduling lead is not booking lead.** Waking the handler *at* the instant
  leaves its preparation — refreshing a session, resolving an id — happening
  after the moment has passed. Wake it early enough to prepare, and let it do
  its own precise wait to T-0. These are two different offsets; naming them
  both `leadMs` guarantees someone conflates them.

## Migrate additively

The new path cannot be verified against production timing until it runs in
production. So land it **dormant**: gated on its own configuration, with the
existing mechanism untouched and still doing the work. Both can run at once
precisely because the handler is idempotent. Remove the old path only after the
new one has been observed doing a real, time-critical run — not merely after it
has been observed publishing.
