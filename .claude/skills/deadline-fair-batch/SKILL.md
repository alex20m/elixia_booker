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
  item's failure from the rest, how retry and warm-up pacing on one item's own
  critical path re-creates the same spread once the queue is gone, and the
  fake-clock trap that makes the test for it pass no matter what the code does.
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

### Check where your lateness number is stamped before you trust it

If the run already records a per-item offset, it is tempting to treat that as
the measurement and skip to a cause. Look at where the line that sets it sits
first, because the plausible place to put it is the wrong one.

The natural spot is the top of the item's work — the first thing after the
wait, where the item is "starting". What that measures is how accurately the
sleep hit the instant. It is stamped **before** the lookups, the parses, the
retries and the request itself, so everything that actually decides the outcome
happens after it and none of it is in the number. Two items a second apart both
report single digits, and the number stays reassuring precisely as the thing it
is supposed to detect gets worse.

It is usually also *named* for what it measures — "first attempt", "started" —
and then read, or printed to users, as though it meant the request landed.
Check the stamp, not the name, and check the wording of anything that renders
it: a message saying an item "completed 1ms after the window opened" when it
means "woke up" sends everyone looking in the wrong place, including you.

What you want is two numbers: **woke** (the offset when the item resumed) and
**sent** (the offset when the request that produced the final outcome went
out), with the request one stamped immediately before the call rather than
after the response, since the question is when you got in the queue and not how
long the answer took. Record the attempt count beside them. The gap between
woke and sent *is* the critical path, and its composition — one slow lookup,
or four retry rounds — tells you which of the two fixes below you need.

Get this in place before concluding anything. A plausible mechanism with no
measurement behind it is a guess, and this particular guess is cheap to make
because the code will happily support several.

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

### When draining is not enough: wait for a known number of racers

Draining bounds *promise chains*. It cannot bound genuinely asynchronous,
off-thread work — `crypto.subtle`, a real filesystem read, anything on the
threadpool. If preparing an item does any of that, then on a loaded machine one
racer can still be inside it with nothing registered, however many turns you
drain. The clock then computes the earliest wake-up from a partial set, jumps to
T-0 for whoever *had* parked, jumps again past the straggler, and the straggler
measures its offset against a clock already seconds beyond its deadline —
reporting a queue that never happened.

That failure is rare, load-dependent, and lands on the one test that would catch
a real regression, so the standing response becomes "re-run it". Which is how
the regression it exists to catch eventually goes through.

No larger drain count fixes this, because the quantity being guessed at is
unbounded. Replace the guess with a fact the test already knows — how many items
are racing — and refuse to move time until that many have parked:

```ts
const instantClock = ({ racers = 1 } = {}) => {
  let barrierCleared = false;
  async function pump() {
    while (waiters.length > 0) {
      if (!barrierCleared) {
        const startedAt = process.hrtime.bigint();          // real: Date is faked
        while (waiters.length < racers && process.hrtime.bigint() - startedAt < GUARD_NS) {
          await new Promise((r) => setImmediate(r));
        }
        barrierCleared = true;
      }
      // ...drain, then advance as before
    }
  }
};
```

Two things about that shape are deliberate:

- **One-shot.** Later phases — a retry loop, a slow dependency's own delay —
  legitimately have different numbers in flight, so a standing barrier would
  deadlock. By the time it clears, each item's first-attempt offset (the only
  thing being measured) is already recorded.
- **The timeout is a liveness guard, not the mechanism.** Without it, a genuine
  regression — where the second item never reaches its sleep — hangs instead of
  failing. **Set it below the runner's own test timeout.** Above it, the suite
  reports an unexplained timeout instead of the assertion naming the lateness,
  and the most useful failure the test can produce is the one you lose. Verify
  this deliberately: break fairness for real and check the output says
  `expected 10000 to be 0`, not `Test timed out`.

Replacing the additive clock is usually a strict improvement for the tests that
already exist: for genuinely sequential sleeps it advances identically.

### Proving a flaky-clock fix

You cannot show absence by running once. Reproduce first, then show it gone:

1. **Get a reliable repro.** Saturate the CPU (`nproc * 2` spinners) and run the
   test repeatedly until you have a failure rate to compare against — a rate,
   not an anecdote.
2. **Establish whose bug it is** before fixing anything, by running the same
   loop on the base branch. A failure rate on `main` that your branch does not
   raise is a pre-existing flake, not something your change caused.
3. **After the fix, re-run the same loop under the same (or heavier) load** and
   require zero failures across many runs.
4. **Then mutate the production code back to broken and watch it go red** — once
   per property, since serialising an inner loop and an outer loop are different
   bugs and one test does not necessarily catch both. A fix that makes a flaky
   test *unable to fail* looks exactly like a fix that worked.

## After the queue: the spread that comes back on one item's own path

Splitting the phases gets every item to the instant together. It does not get
them *through* it together, and the user-visible symptom is identical — same
operation, wildly different outcomes, nothing errored. So when the report
persists after the batch is fair, stop reading the loop and read one item's
path from the instant to its request. Two things on it re-create the spread.

Which one you have is a question for the *sent* offset and the attempt count
above, not for reading alone: one attempt with a long woke-to-sent gap is the
second problem, several attempts is the first. Both are worth fixing on their
own merits, but only the measurement says which one is costing someone their
place today.

### Polling is not backing off

Exponential backoff with jitter is the reflex for any retry, and for one of the
two waits on this path it is actively wrong.

- **The other side pushed back** — a rate limit, a transport error. It is
  asking to be asked less often, so the delay should grow, and a
  server-supplied retry hint outranks your own schedule.
- **The thing does not exist yet** — the listing is unpublished, the window has
  not flipped, the record has not propagated. Nobody is pushing back. The only
  quantity that matters is how soon after it appears you notice.

Backing off from the second is self-defeating in three compounding ways, and
the third is the one that produces the report:

1. **Lateness grows without bound**, up to the backoff cap. The longer the
   thing takes to appear, the less often you are looking for it.
2. **You are slowest exactly when it is most contested.** Something that takes
   seconds to appear is something many clients are waiting on.
3. **Two clients diverge.** Each jitters independently and the growth is
   multiplicative, so within a handful of attempts their probe schedules are
   unrelated. The gap between the luckiest and the unluckiest is roughly the
   cap itself — and that gap, not the average, is what someone notices when
   their colleague's request landed and theirs did not.

So give the two waits separate caps: keep the exponential band for push-back,
and cap the "not there yet" band tight. Do not simply lower the one shared cap.
That turns polite retrying into hammering the moment something is genuinely
overloaded, which is the failure the backoff existed to prevent — and it is the
change most likely to be made by someone tuning for politeness who has not read
this.

Pick the tight cap by naming what it buys and what it costs, because it is
directly both:

- it **is** the worst-case lateness once the thing appears;
- it **is** the worst-case spread between two clients on the same instant;
- `budget / cap` **is** the worst-case request count, paid only in the run
  where the thing never appears at all. In a normal run it shows up within a
  probe or two and the volume is unchanged.

Write the chosen number down with that arithmetic beside it. Without it the
value reads as arbitrary, and the next person lowers the frequency for
politeness without knowing they are also raising the spread.

### The connection you prepared with is already gone

Preparing early is the whole point of the split — but a run that prepares and
then waits tens of seconds for its instant is idle far longer than any HTTP
keep-alive. The socket is closed by the time it matters, so the first request
at the instant silently pays for a fresh TCP and TLS handshake: tens to
hundreds of milliseconds, varying per client and per run. Unpredictable
per-item cost on the hot path is exactly what the fair batch exists to remove.

Make one last **real** request shortly before the instant. Real, not a
synthetic ping: a request to someone else's service whose only purpose is
warming is rude, and is the first thing deleted by whoever reads it later.
Reuse the preparation step you already have — retry the lookup or resolution
that came back empty earlier. It warms the connection as a side effect, and it
may simply succeed, which removes a whole round trip from the critical path.

Three things this has to get right:

- **Never await it.** A probe that stalls on a dead connection would delay the
  one request it exists to speed up, turning the optimisation into the bug.
  Fire it, let the remaining wait run, and use its answer only if it arrived.
  Attach the rejection handler at the call site, or an unhandled rejection
  takes the process down.
- **First writer wins.** Once a probe and the race can both produce the same
  value, a straggler landing mid-request must not swap it out underneath.
  Guard the assignment, and have the race read the value once into a local
  rather than re-reading a field that can change beneath it.
- **Place it close, but not too close.** Far enough out that a probe on a slow
  connection can still land before the instant; near enough that the connection
  it opens is still alive when the real request needs it.

Both of these are testable with no network and no real clock. For the pacing,
drive the retry loop with a jitter source pinned to its maximum and assert the
*sequence* of waits, so the failure prints the grid rather than a boolean — and
assert separately that a genuine push-back still gets the exponential band, or
the "cap everything" mutation ships unnoticed. For the probe, assert the order
of sleeps and lookups, and assert that a probe which never settles still leaves
the request going out at offset ~0.

## What to check before calling it fixed

- A test that fails on the old code with the *lateness* number, not just a
  different one.
- The nested loop, if there is one, covered too.
- One item's failure proven not to take the others down.
- Per-item state actually per-item — mutate it back to shared and watch a test
  go red, since nothing else will tell you.
- The limiter's comment says why the hot path is deliberately ungated.
- The lateness number is stamped at the request, not at the item's wake-up,
  and anything that renders it says which one it means.
- "Not there yet" and "please slow down" have separate delay caps, with a test
  pinning each band, so capping both cannot ship as a politeness fix.
- The tight cap is written down with what it costs in request volume.
- A pre-instant probe, if there is one, is unawaited, its rejection handled,
  and proven not to delay the request when it never settles.
