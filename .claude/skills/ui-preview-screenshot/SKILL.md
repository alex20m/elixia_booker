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
   publish. Do this before staging, not after. Then clear the framework's build
   cache: a dev server that generates per-route types leaves one behind
   *importing the route you just deleted*, so the typecheck fails on a
   gitignored generated file and the error points at nothing you wrote.

## Traps

- **The shutter can catch a transition mid-flight, and the half-interpolated
  frame reads as a *state*.** A control whose colours are a third of the way
  from filled to outlined photographs as a greyed-out, disabled-looking button,
  and the obvious next move — hunting the CSS rule that disabled it — finds
  nothing, because `getComputedStyle` returns the interpolated colour too and
  agrees with the picture. Two habits kill it: move the pointer off the element
  before shooting (whatever you clicked to get here is often exactly where the
  new control lands, so it is hovered), and pause past the longest transition.
  If a computed colour matches no token in the stylesheet, that is the tell.
- **A third-party stylesheet can carry a reset that silently disables your own
  rules.** A component library's CSS import commonly ships a preflight that
  clears list markers, form styling and heading margins across the whole
  document, so a rule of yours that assumes browser defaults renders as nothing
  — and every test still passes, because no unit test applies CSS at all. The
  give-away is a stylesheet that styles something invisible in the shot (a
  `::marker` colour where no markers appear). Fix it by restating the property
  explicitly rather than by fighting the import.
- **The scratch script cannot resolve the browser driver** when it lives outside
  the project. Import it by absolute path from the project's modules, or run the
  script from the project root.
- **A sandbox usually pre-installs the browser** at a fixed path with downloads
  disabled. Point the launcher at that binary rather than triggering an install
  that will fail or silently take forever.
- **`--window-size` is the window, not the viewport.** Driving the full browser
  binary headlessly (`chrome --headless --screenshot --window-size=W,H`) writes
  a W×H image whose page viewport is *shorter* — the space a window's chrome
  would occupy is subtracted. Content is silently clipped at the bottom, and
  `100vh` is smaller than the image you are looking at. The symptom points at
  your CSS, which is why it costs an hour. Use the dedicated headless binary
  (`headless_shell`) where one is installed: its viewport matches the requested
  size exactly. A body background hides this, because the body's background
  propagates to the canvas and paints the whole window — so a solid-colour probe
  will *not* reveal it. Probe with an element that has its own background and
  check where it ends.
- **Screenshots are opaque unless you ask.** Pass
  `--default-background-color=00000000` for transparency, or rounded corners and
  masked shapes come out on white. Check the result really is RGBA.
- **An `<img src="…svg">` sized by CSS can render clipped** rather than scaled.
  When rasterising a vector, inline the SVG into the page instead of linking it.

### Framework traps for the throwaway route

- **Forcing a theme from the URL has to happen in `<head>`, and has to write
  wherever the theme provider reads.** Two separate things defeat the obvious
  approach. A `<script>` rendered inside a client component does not run until
  React hydrates, and on a cold dev build that can be slower than the shutter —
  so the shot silently captures the default theme, and both "light" and "dark"
  images come out identical. Then, once hydration *does* happen, a theme
  provider (next-themes and friends) reads its own storage key on mount and
  overwrites whatever class you set. So the override belongs in the document
  head, and it must set the storage key as well as the class. Two byte-identical
  screenshots from two different theme URLs is the tell for both.

- **A route folder starting with `_` is private in Next's app router** and
  serves a 404. Naming the scratch page `app/__preview` looks like the
  convention for "obviously temporary" and is exactly the name that will not
  route. Use an ordinary segment, e.g. `app/preview-scratch`.
- **`next dev` edits the repo's agent instructions file.** It appends a
  `<!-- BEGIN:nextjs-agent-rules -->` block to `CLAUDE.md` (see
  `node_modules/next/dist/server/lib/generate-agent-files.js`), so starting a
  preview server leaves an unrelated modification in the working tree. Notice it
  before staging, and decide deliberately whether that block belongs in your
  diff — do not let it ride along in an unrelated PR.
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
