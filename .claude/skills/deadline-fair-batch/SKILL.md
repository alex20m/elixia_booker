---
name: deadline-fair-batch
description: >-
  Keep one scheduled run from turning independent, time-critical work into a
  queue, so the last item in a batch hits its deadline as precisely as the
  first. Use whenever one invocation handles many users' or many items' work
  against an external instant — a booking that opens, an auction that closes, a
  rate window that resets, a notification that has to land on the minute — and
  whenever someone reports that the same operation was fast for one person and
  slow for another. Covers why the compounding is invisible in logs and metrics,
  which parts of the run may be throttled and which must never be, isolating one
  item's failure from the rest, and the fake-clock trap that makes the test for
  it pass no matter what the code does.
---

# Fair batches: everyone races, nobody queues

A worker wakes up, finds N items due, and handles them in a loop. Each item has
its own hard external instant — the moment a class opens for booking, a bid
closes, a quota resets — and the whole value of the job is landing on it.

The loop is the bug. Item *k* does not start until items 1…*k*−1 have finished
everything they do: their retries, their database writes, their notification
sends. The cost is not spread evenly, it **accumulates**, so the last item in
the batch pays for every item before it.

The tell is a user report, not an alert: *"mine went through in 3ms, my friend's
took ten seconds."* Both succeeded. Nothing errored.

## Why nothing catches it

- **Every item reports success.** Late is not failed. The batch returns the same
  count it always did.
- **Duration metrics look reasonable.** Total run time is the sum, and the sum
  is under the timeout. Nobody is watching per-item lateness.
- **It is invisible at N=1.** Every test with one item, and every hand-run in
  development, is perfectly punctual. It only appears under the concurrency the
  feature exists for.
- **Ordering is arbitrary but stable-looking.** Whoever is first in the map is
  always fast, so the same user reports it working and the same user reports it
  broken — which reads like their account, their network, their device.

So look for it by reading the loop, not by waiting for it to page you: *does
anything in this iteration's body have to finish before the next iteration's
deadline?* If yes, the loop is a queue.

## The fix, and the part of it that is easy to get backwards

Split the run into three phases and treat them differently:

1. **Prepare** — load the record, refresh the session, resolve identifiers.
   Everything that can be known before the instant. Run concurrently, but
   **throttled**.
2. **Race** — the wait to the instant and the request itself. Run concurrently
   and **never throttled**.
3. **Follow up** — persist the result, notify, emit metrics. Concurrent and
   **throttled**.

The instinct after "make it parallel" is to reach for a concurrency limit and
put it around everything, because unbounded fan-out against a database or a
third-party API is its own outage. That instinct is right about phases 1 and 3
and **exactly wrong about phase 2**: a limiter on the race is a queue with extra
steps. With a limit of 8 and 50 items, item 49 waits for a slot — which is the
original bug, reintroduced by the thing that was supposed to fix it.

Say why in a comment at the limiter's definition. The next person to read it
will assume the missing limit on the hot path is an oversight and add one.

Two more things the split has to get right:

- **Contain each item's failures.** Once items run together, one rejection out
  of an all-or-nothing combinator abandons every sibling still waiting on its
  instant — so a single failed read costs everyone their slot. Wrap each item so
  it can only lose itself, and record why it dropped out.
- **Give each item its own per-item state.** Anything scoped to "the current
  item" — a logger holding the reference instant offsets are measured against, a
  progress counter, an accumulating context — was safe only because one item ran
  at a time. Shared, it now reports one item's numbers against another's
  baseline, and the corruption lands in exactly the diagnostics someone will use
  to investigate the lateness.

## Testing it: assert lateness, not duration

The assertion that catches this is **per item, how far from its own deadline did
its request go out** — not how long the batch took. Total duration barely moves
when work overlaps versus when it queues, and it is dominated by whatever is
slowest either way.

So the item under test needs to record its own offset from its own target, and
the test needs at least two items sharing one deadline, with the work
deliberately slow:

1. Two items, same target instant, and assert the premise — that the two targets
   really are equal. Without that the test proves nothing and will quietly stop
   proving it when a fixture changes.
2. Make the operation take a long time, on the fake clock (ten seconds is a
   realistic exhausted-retry sequence).
3. Assert **both** offsets are ~0. Serially, whichever ran second is ~10s late.

Run it against the pre-fix code and read the failure: it should say `10000`, not
merely differ. That number is the bug.

Do the same for the second level of the loop if there is one — several items
belonging to *one* user is the same queue one nesting deeper, and fixing only
the outer loop leaves it.

### The fake clock that makes the test vacuous

This is the trap, and it is silent. The usual test clock for "sleep without
really sleeping" is additive:

```ts
const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
```

It cannot represent concurrency. Two items sleeping 30s **side by side** advance
it to +60s, exactly like two sleeping **one after another**. Under it, the
parallel implementation and the serial one produce identical timings — so the
fairness test passes before the fix, passes after it, and would pass against an
empty function. It is a test that cannot fail.

Use a virtual clock instead: `sleep` registers a wake-up *instant*, and time
**jumps to the earliest one still pending** rather than accumulating.

```ts
const waiters: { at: number; wake: () => void }[] = [];

async function pump() {
  while (waiters.length > 0) {
    // Let everything that can progress at the current instant do so, so the
    // clock only moves when the run is genuinely waiting on it.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));

    const earliest = Math.min(...waiters.map((w) => w.at));
    if (earliest > t) setTime(earliest);
    const ready = waiters.filter((w) => w.at <= t);
    for (const w of ready) waiters.splice(waiters.indexOf(w), 1);
    for (const w of ready) w.wake();
  }
}

const sleep = (ms: number) =>
  new Promise<void>((wake) => {
    waiters.push({ at: t + ms, wake });
    void pump();
  });
```

The drain loop before advancing is the part that matters and the part that looks
superfluous: without it the clock leaps ahead while an item is still between
"finished preparing" and "registered its sleep", and that item is then measured
as late for a reason the production code does not have. Flushing the queue a
number of times is a pragmatic stand-in for "nothing is runnable any more" —
`setImmediate` yields between microtask drains, so a handful of rounds covers
ordinary promise chains, but it is a heuristic. If a test starts depending on
the exact count, that is a signal the code under test has real asynchrony the
clock is not modelling, not a signal to raise the number.

Replacing the additive clock is usually a strict improvement for the tests that
already exist: for genuinely sequential sleeps it advances identically.

## What to check before calling it fixed

- A test that fails on the old code with the *lateness* number, not just a
  different one.
- The nested loop, if there is one, covered too.
- One item's failure proven not to take the others down.
- Per-item state actually per-item — mutate it back to shared and watch a test
  go red, since nothing else will tell you.
- The limiter's comment says why the hot path is deliberately ungated.
