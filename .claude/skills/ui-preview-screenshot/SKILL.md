---
name: ui-preview-screenshot
description: >-
  See a UI change rendered with real CSS, in every theme and at phone width,
  before shipping it — by driving the app in a headless browser behind a
  throwaway route. Use whenever a change is visual (spacing, colour, focus
  rings, dark mode, a new component's look) and the component sits behind a
  login, a server action, or a backend the sandbox cannot reach. Covers why the
  unit suite cannot catch these bugs, how to reach an unreachable UI state
  without a backend, and the cleanup that has to happen before committing.
---

# Look at it before you ship it

A component test renders your markup into jsdom, which **applies no
stylesheet**. Every class name is an opaque string there. So the suite is
perfectly happy with a colour that vanishes in dark mode, a focus ring clipped
by an ancestor, six boxes that overflow a 360px phone, or a token that does not
exist. Those are exactly the bugs a visual change ships.

The fix is to render the real page with the real CSS pipeline and look at it.
The obstacle is usually that the interesting state is unreachable: it is behind
a login, three steps into a flow, or needs a server that needs a database that
needs credentials the sandbox does not have.

## The procedure

1. **Do not use the project's dev wrapper script.** Those scripts tend to start
   a local database, run migrations, seed, and require a container runtime —
   none of which a sandbox has, and none of which a screenshot needs. Invoke the
   framework's dev server directly instead.
2. **Satisfy config validation with dummy values.** Apps commonly validate
   required env vars at import time and throw if one is missing, which kills the
   server before any page renders. Write a temporary local env file with
   syntactically valid but fake values — the preview never talks to those
   services. Check it is gitignored.
3. **Add a throwaway route that renders the state you want.** This is the part
   that makes the unreachable reachable: a page that mounts the real component
   and passes stubs where the real app passes server actions. Have the stubs
   return the shapes the component branches on — including the failure shapes,
   which are the ones nobody ever looks at.
4. **Drive it and shoot each state.** Script the clicks and typing that walk the
   component into each state, and screenshot after each. Screenshot the
   *component's container*, not the full page — a card-sized image you can
   actually read beats a mostly-empty viewport.
5. **Cover the axes that break independently:** every theme, phone width as well
   as desktop, and the error/empty/disabled states. A theme is usually a class
   on the root element, so you can toggle it in-page instead of restarting.
6. **Delete the throwaway route and env file, then check `git status`.** A
   preview route that reaches the default branch is a live URL nobody meant to
   publish. Do this before staging, not after.

## Traps

- **The scratch script cannot resolve the browser driver** when it lives outside
  the project. Import it by absolute path from the project's modules, or run the
  script from the project root.
- **A sandbox usually pre-installs the browser** at a fixed path with downloads
  disabled. Point the launcher at that binary rather than triggering an install
  that will fail or silently take forever.
- **Wait for the state, not for a duration.** Wait on the element that proves
  you arrived; use a short fixed pause only to let a transition settle before
  the shutter.
- **Assert the invisible things while you are in there.** Focus location, input
  value, and whether a field cleared are cheap to read from the live page and
  tell you things a screenshot cannot.

## What this does not replace

Screenshots are a check on you, not a regression test — nothing here fails in
CI. Behaviour still gets a test in the suite (see `test-first`); the screenshot
only covers what the suite structurally cannot see. If a visual bug turns out to
be driven by state (wrong branch, stale value), that part *is* testable, so
write the failing test for it as well.
