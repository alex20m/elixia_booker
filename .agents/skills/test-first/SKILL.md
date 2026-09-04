---
name: test-first
description: >-
  Write tests that are proven able to fail, by watching them fail before making
  them pass. Use whenever you are adding behaviour, fixing a bug or a crash,
  writing or changing any test, or deciding what to do about a test that just
  went red — and especially when a change is about to ship with no human
  reviewer, where the suite is the only thing standing between it and
  production. Covers the red-first loop, how to verify a regression test really
  catches its bug, how to recognise tests that cannot fail, and the one narrow
  case where changing a test instead of the code is legitimate.
---

# Test first, and watch it fail

A test you have never seen fail has not been shown to test anything. It might be
asserting something real, or it might be passing because it asserts nothing,
because it tests a mock, or because it never runs the code you think it does.
From the green tick, those look identical.

So the discipline is not "write tests". It is **produce a red, then turn it
green.** Everything below is that idea applied to the situations you actually
meet.

## The loop for new behaviour

1. **Write the test** describing what the behaviour should be, in terms an
   outsider could check: inputs, outputs, observable effects.
2. **Run it and watch it fail.**
3. **Read the failure.** It must fail for the *right reason* — a wrong value, a
   missing element, an unmet expectation. If it fails on an import error, a typo,
   a missing fixture, or a mistyped selector, you have learned nothing yet: fix
   the test and get back to a real failure first.
4. **Implement** until it passes.
5. **Clean up** with the test green.

Step 3 is the one people skip, and it is the one that does the work. A test that
red-lights because it cannot even run has not demonstrated that it is watching
the behaviour you care about.

### When you genuinely cannot write it first

Sometimes the behaviour is not statable until you have explored the code. Write
the test afterwards, then buy back the missing evidence: **break the
implementation on purpose**, run the test, confirm red, restore.

```bash
# make a small deliberate change to the source the test claims to cover
<edit the source>
<run the test>          # must be RED — if green, the test is not watching this
git checkout -- <source-file>
<run the test>          # back to GREEN
```

Same guarantee, obtained later. Only the ordering slipped, not the proof.

## Regression tests: verify against the bug, not the fix

When you fix a bug, the test ships with the fix and must fail without it.

1. **Reproduce the reported bug** — the actual symptom, not merely the code path
   near it. Use the specific input, state, timing, or boundary that triggered it:
   the empty list, the first or last element, the missing field, the timezone
   edge, the second click, the failed request.
2. **Prove it catches the bug** by removing the fix and running the test:

```bash
git stash push -- <the-fixed-source-files>
<run the test>          # must be RED
git stash pop
<run the test>          # must be GREEN
```

If it stays green without the fix, it is not a regression test — it is a test of
something adjacent. Rewrite it until removing the fix turns it red.

Pick the level that actually catches the thing: unit for logic, integration for
wiring and data flow, UI for rendering and interaction. A unit test cannot catch
a bug that only exists once two correct pieces are connected.

This applies to every fix, however small. A one-line fix still gets a test. The
only exception is a change with no observable behaviour — pure formatting,
comments, renames — and then say in the PR why no test was added.

### Hydration mismatches are unit-testable

A hydration mismatch — the server's HTML disagreeing with the DOM React finds
when it hydrates — reads like a browser-only bug, so it tends to ship with no
test at all. It is reachable from a DOM-environment unit test, because the bug is
three ordered steps and the report is a `console.error`:

1. Server-render the tree the framework would ship and parse it into the test
   document (`document.write`), so the root element's own attributes exist.
2. Apply by hand whatever mutates the DOM before React runs — a theme provider's
   blocking script, a browser extension's shim.
3. Hydrate the same tree into that document and assert nothing
   hydration-related reached `console.error`.

The order *is* the test: mutating before hydrating reproduces the bug, mutating
after it reproduces nothing.

A test shaped like that can pass vacuously in several ways at once, so pair it
with a control that hydrates an equivalent tree **without** the fix and asserts
the mismatch *is* reported. Without the control, a console spy that never
attached, a hydrate call that silently did nothing, and a suppression accidentally
covering a whole subtree all read as a pass.

## Every test must be able to fail

Before committing a test, ask: **what realistic bug would turn this red?** If
there is no answer, the test is decoration. Decoration is worse than no test,
because it buys confidence nobody checked.

Patterns that cannot fail, and what to do instead:

| Shape | Why it can't fail | Fix |
|---|---|---|
| Renders a component and asserts nothing about what rendered | Any non-crashing render passes | Assert on visible text, roles, or emitted calls |
| Asserts on a mock's return value | Proves the mock works, not the code | Assert what the code *did* with it |
| `toBeDefined`, `toBeTruthy`, bare `not.toThrow` | Almost any implementation satisfies these | Assert the specific expected value |
| Expectation recomputes the implementation's arithmetic | Both change together; the bug survives | Write the expected value out literally |
| Snapshot of a whole tree, updated whenever it breaks | Records behaviour rather than asserting it | Assert the few things that matter |

**Existing tests of this kind may be rewritten or deleted.** A test that cannot
fail is protecting nothing, so removing it costs no coverage — but say in the PR
which ones you replaced and why, since a shrinking test count otherwise looks
like a regression.

## Test the contract, not the internals

- Assert inputs, outputs, and observable side effects. A refactor that preserves
  behaviour should keep the suite green; if it does not, the tests were watching
  the implementation.
- Prefer what a user perceives — visible text, roles, requests actually sent —
  over class names, internal state, or call counts of incidental helpers.
- **Cover the unhappy paths**, which is where the bugs are: errors, empty and
  single-element collections, permission denials, offline and failed requests,
  and boundaries — first and last element, midnight, DST, empty string, `null`.
- **Name the test after the behaviour it guarantees**, so a failure explains
  itself: `refuses to share edit access when the sharer only has view` tells you
  what broke; `test share 3` does not.

## When a test goes red

A red test is the system working. It caught something before a user did.

**Diagnose before you touch anything.** There are exactly two possibilities:

- **The code is wrong.** This is the default and by far the more common. Fix the
  code.
- **The intended behaviour deliberately changed.** Then the test encodes an
  intention that is no longer true, and updating it is correct — but say so
  explicitly, in the commit message and the PR, naming the behaviour that
  changed. This is the only legitimate reason to change a test to make a change
  pass.

Never reach green by loosening an assertion, deleting a case, adding a
conditional skip, widening a matcher, mocking away the thing under test, or
marking it `skip`/`only`. Each of those converts a caught bug into a shipped one
while leaving the tick green.

**Never re-run a flaky test until it passes.** A test that passes or fails
non-deterministically on unchanged code is broken, and the flake is usually
telling you about a real race, ordering dependency, or shared state — often the
same one your users will hit. Fix the cause. If a test is genuinely, temporarily
unrunnable, that is a blocker to raise, not to hide.

## Before you call it done

- Every new test has been seen failing — first, or afterwards by deliberate
  mutation.
- Every bug fix has a test verified red without the fix.
- No test was weakened, skipped, or mocked into passing.
- The suite runs clean locally, not just the tests you touched.
