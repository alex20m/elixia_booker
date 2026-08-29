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

### What wakes the booking up

Two schedulers can drive `/api/cron/tick`, which sleeps to the exact release
millisecond and then books with jittered retries inside a ~30s budget.
`lib/schedule.ts` does the "N days before" math in the user's own timezone,
DST included, and releases are claimed atomically (`claimDue`) so any number of
overlapping callers can't double-book. That idempotence is what lets both
schedulers run at once.

**QStash (Upstash) — the primary.** Every reindex hands each upcoming release
instant to QStash as a delayed HTTP call (`lib/qstash.ts`), so the wake-up
comes from a service whose whole product is delivering a request at a chosen
time. Nothing has to already be running for a release to be noticed, and
nothing has to be cancelled when a subscription changes: messages are keyed by
instant, and a tick that finds nothing due returns.

**GitHub Actions — the fallback.** `.github/workflows/watch.yml` runs a
long-lived job that sleeps to the release on the runner's own clock; a new one
starts every 3 hours and each runs ~5h50m, so one is always awake well before
the previous deadline. This exists because GitHub's cron can *drop* a scheduled
trigger outright under load rather than merely delay it — which is also why it
is no longer the primary, and why `watchdog.yml` re-dispatches a watcher when
none is active.

### Scheduling that lives outside the repo

Two things are configured in QStash rather than in this codebase, and neither
is recreated by a deploy — if you move to a fresh QStash account you must run
these again. Both need `QSTASH_TOKEN`, `CRON_SECRET` and your `APP_URL`.

The nightly reindex, which reprojects every account's upcoming releases and is
what feeds QStash new instants in the first place:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/$APP_URL/api/cron/reindex" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Schedule-Id: nightly-reindex" \
  -H "Upstash-Cron: 17 3 * * *" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET" \
  -H "Upstash-Timeout: 60s" \
  -H "Upstash-Retries: 3"
```

`Upstash-Schedule-Id` makes that command idempotent — re-running it updates the
one schedule instead of adding another. **`Upstash-Forward-Authorization`, not
`Authorization`**: the plain header authenticates you *to QStash* and is
consumed there, so using it would leave the endpoint's own Bearer guard
unsatisfied and every nightly run 401ing into the dead-letter queue.

Check what is actually configured with:

```bash
curl -H "Authorization: Bearer $QSTASH_TOKEN" https://qstash.upstash.io/v2/schedules
```

#### Why the publish horizon is shorter than the reindex horizon

`REINDEX_HORIZON_DAYS` projects 10 days ahead, but QStash refuses any delivery
scheduled beyond its plan's maximum delay (7 days on the free tier) — and it
validates a batch as a unit, so a single over-limit instant rejects *every*
message in the same request, including tomorrow's. `lib/qstash.ts` therefore
clamps what it enqueues to `MAX_TICK_DELAY_MS` and lets the nightly run publish
the rest as they come into range. Nothing is lost, because the reindex repeats
every night and the clamp leaves days of slack.

If you upgrade the QStash plan, `QSTASH_MAX_DELAY_MS` is the number to raise.
Confirm the new ceiling by publishing a deliberately over-limit probe message
and reading the limit back out of the error, rather than trusting the pricing
page — the row has been renamed before.

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
