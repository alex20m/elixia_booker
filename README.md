# Elixia Booker

Books your group fitness classes at [Elixia](https://www.elixia.fi) (SATS Group)
the moment booking opens.

**TypeScript · Next.js · Neon (Postgres + Auth) · Vercel · GitHub Actions** — all
on free tiers.

Deploy it once. After that, anyone you share the URL with creates an account,
answers three setup questions, links their gym login, picks their classes, and
is done.

---

## How it works

- `lib/elixia.ts` talks to the real Elixia API (login, schedule, booking),
  reverse-engineered from captured traffic — see [docs/api.md](docs/api.md).
  A mock backend (`MOCK_ELIXIA=1`) covers local dev and tests.
- Sign-in is cookie-based (a SATS Group Keycloak OAuth2 flow), not tokens.
- Booking never gets rejected outright — you're either booked or waitlisted,
  and both count as success.
- A class doesn't appear on the schedule until its booking window opens, so
  its id is resolved right before booking if it wasn't available earlier.

### The booking watcher

`.github/workflows/watch.yml` runs a long-lived job that sleeps until the
exact release millisecond, then books with jittered retries inside a ~30s
budget. GitHub Actions' own cron isn't punctual enough for this, so instead:
a new watcher job starts every 3 hours and each one runs for ~5h50m, so one
is always awake well before the previous deadline — timing comes from the
runner's clock, not the scheduler. Releases are claimed atomically so two
overlapping watchers can't double-book. `lib/schedule.ts` does the "N days
before" math in the user's own timezone, DST included.

## Setup that can't be skipped

Every new account must set **membership** (7 or 14 day window), **timezone**,
and a **notification channel** — none of these have a default, because a
wrong guess means silently missing bookings. Until they're set, the API
returns `428 Precondition Required`.

## Two logins, on purpose

Your **Booker account** (Neon Auth) is separate from your **Elixia
credentials**, which you link afterwards. This keeps the app usable even if
Elixia's own login is hostile to automation, and lets Neon Auth handle
verification, password reset and sessions.

- Your Booker password is never seen by this app.
- Your Elixia password and session cookies are encrypted at rest
  (AES-256-GCM) under a key that lives only in the environment.
- Every database query is scoped to the signed-in user; `tests/neonRepo.test.ts`
  checks isolation against real Postgres.

## Layout

```
app/          Next.js App Router — pages, dashboard, setup, API routes
lib/          booking logic, Elixia adapter, scheduling, crypto, db repo
db/           migrations (node-pg-migrate)
public/       service worker, icons, fonts
.github/      CI workflows and the booking watcher
```

The `Repo` interface (`lib/db/`) is why the storage backend has changed
twice without touching booking logic.

## Interface

Mobile-first: three tabs (Classes, Activity, Settings), styled with SATS
Group's own design tokens (`app/globals.css`) so it feels at home next to
the gym's app. Installable as a PWA on both desktop and mobile.

## Tests

```bash
npm test           # full suite, no services required
npm run typecheck
npm run lint
npm run build
```

Covers DST-aware scheduling, retry bounds, encryption, cron auth, per-user
isolation, and CI pipeline shape. Also mutation-tested against dozens of
deliberately broken variants to confirm the suite actually catches them.

### CI/CD

Two workflows (`pull-request.yml`, `main.yml`) run lint/typecheck/test/build
— neither deploys or migrates. Vercel's Git integration deploys every push;
`vercel.json` runs migrations as part of the build (`npm run migrate && next
build`) so a failed migration blocks the deploy instead of shipping a broken
schema.

## Design constraints

- No browser automation — the Elixia adapter uses plain `fetch`.
- Every action is scoped to the acting user's own account.
- Bounded, polite retries; duplicate subscriptions are refused.
- Failures are surfaced and notified, never silent.
