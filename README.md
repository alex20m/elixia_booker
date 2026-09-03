# Elixia Booker

Books your group fitness classes at [Elixia](https://www.elixia.fi) (SATS Group)
the moment booking opens.

**TypeScript · Next.js · Neon (Postgres + Auth) · Vercel · QStash** — all on
free tiers. (GitHub Actions runs the CI checks and nothing else.)

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
- Each class shows who's currently down to run it, refreshed nightly by its
  own job (`/api/cron/instructors`) — kept apart from booking and reindexing
  so a change to how instructor names are read can't affect either.

### What wakes the booking up

QStash (Upstash) drives `/api/cron/tick`, which sleeps to the exact release
millisecond and then books with jittered retries inside a ~30s budget.
`lib/schedule.ts` does the "N days before" math in the user's own timezone,
DST included, and releases are claimed atomically (`claimDue`) so a retried or
duplicated delivery can't double-book.

Every reindex hands each upcoming release instant to QStash as a delayed HTTP
call (`lib/qstash.ts`), so the wake-up comes from a service whose whole product
is delivering a request at a chosen time. Nothing has to already be running for
a release to be noticed, and nothing has to be cancelled when a subscription
changes: messages are keyed by instant, and a tick that finds nothing due
returns. Published messages carry no secret — the cron endpoints authenticate a
QStash delivery **only** by verifying its signature
(`QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY`), not by any forwarded
header, because QStash shows a message's headers in the clear in its own
dashboard and events API to anyone with account access. A deployment with no
signing keys set refuses every cron request.

This replaced a long-lived GitHub Actions job that slept to the release on the
runner's own clock, backed by a watchdog that re-dispatched it. GitHub's cron
can *drop* a scheduled trigger outright under load rather than merely delay it,
and starting that job still depended on it — which is why it is gone.

### Scheduling that lives outside the repo

The nightly reindex is configured as a QStash schedule, not in this codebase,
and a deploy does not recreate it — if you move to a fresh QStash account you
must run this again. It needs `QSTASH_TOKEN` and your `APP_URL`. The reindex is
what reprojects every account's upcoming releases and feeds QStash new instants
in the first place, so without it nothing is ever booked:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/$APP_URL/api/cron/reindex" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Schedule-Id: nightly-reindex" \
  -H "Upstash-Cron: 17 3 * * *" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Timeout: 60s" \
  -H "Upstash-Retries: 3"
```

`Upstash-Schedule-Id` makes that command idempotent — re-running it updates the
one schedule instead of adding another. **No `Upstash-Forward-Authorization`
here on purpose**: forwarding a shared secret as a Bearer header so the
endpoint's guard accepts it would leave that secret in plaintext in QStash's
own dashboard and events API for as long as its retention window keeps it. The
endpoint verifies the request's QStash signature instead (`lib/http.ts`
`assertCronAuthorised`), which needs nothing in the schedule or the message to
prove where it came from. The `Authorization` header above authenticates *you*
to QStash's API when running this command — it is never sent on to the app.

The nightly instructor sync, which refreshes who the schedule currently says
is running each class — its own schedule, not folded into the reindex above,
for the same isolation reason `lib/service.ts`'s `refreshInstructors` gives:

```bash
curl -X POST "https://qstash.upstash.io/v2/schedules/$APP_URL/api/cron/instructors" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Schedule-Id: nightly-instructors" \
  -H "Upstash-Cron: 43 3 * * *" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Timeout: 60s" \
  -H "Upstash-Retries: 3"
```

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

Choosing **email** as the channel needs the deployment itself to have
`RESEND_API_KEY` (a [Resend](https://resend.com) API key) and
`NOTIFY_FROM_EMAIL` (a sender verified against a domain on that Resend
account) set — the setup pages offer email regardless, since nothing else in
the account decides whether the deployment can send it. Without either,
`sendEmail` (`lib/email.ts`) treats it the same as any other "nobody to
tell" and drops the alert silently, by design — a notification failure must
never fail the booking it is reporting. `/api/health`'s `emailConfigured`
field and the "not being delivered" banner on the Settings and setup pages
are what surface the gap instead; check the former to confirm the
deployment itself is configured, and expect the latter if you pick email
before it is.

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

**Deleting an account** needs `NEON_API_KEY`. The managed Neon Auth instance
does not expose Better Auth's own `/delete-user` route — it answers 404 — so
"Delete account" removes the identity through the Neon API
([docs](https://neon.com/docs/reference/api/auth/delete-branch-neon-auth-user))
and then purges the app's own data. Mint the key by hand in the Neon console
(Account settings → API keys) and add it in Vercel; `NEON_PROJECT_ID` is
already there from the Neon integration. Without the key nothing else is
affected — only that button fails, with the reason shown to the user.

## Layout

```
app/          Next.js App Router — pages, dashboard, setup, API routes
lib/          booking logic, Elixia adapter, scheduling, crypto, db repo
db/           migrations (node-pg-migrate)
public/       service worker, icons, fonts
.github/      CI workflows (checks only — no deploy, no cron)
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
npm run test:e2e   # drives the real UI in a browser; builds and starts the app itself
```

Covers DST-aware scheduling, retry bounds, encryption, cron auth, per-user
isolation, and CI pipeline shape. Also mutation-tested against dozens of
deliberately broken variants to confirm the suite actually catches them.

`test:e2e` (Playwright, see `playwright.config.ts` and `tests-e2e/`) drives
the sign-in flow and the real dashboard in a real browser against a real,
built instance of the app — with `ENCRYPTION_KEY` and `MOCK_ELIXIA=1` set for
that build, so a sign-in reaches a real, bookable dashboard (backed by the
in-memory repo) rather than stopping at "could not load your account" — and a
small fake Neon Auth server (`tests-e2e/fixtures/fakeNeonAuth.ts`) standing in
for the managed service. This is the layer that catches a bug the unit suite
can't, because it only exists in what the browser actually shows: a toast
nobody sees, a retry that fixes the network call but not the screen, a
combobox that never wires the "Add class" button up. No real credentials or
services needed; it builds and serves the app itself, so the first run takes
a bit longer.

### CI/CD

Two workflows (`pull-request.yml`, `main.yml`), each two parallel jobs:
`verify` runs lint/typecheck/test/build, and `e2e` builds and runs the
Playwright suite above in a real browser — split out because it is by far the
slowest part and does not need to wait on the other four. Neither job deploys
or migrates. Vercel's Git integration deploys every push; `vercel.json` runs
migrations as part of the build (`npm run migrate && next build`) so a failed
migration blocks the deploy instead of shipping a broken schema.

## Design constraints

- No browser automation — the Elixia adapter uses plain `fetch`.
- Every action is scoped to the acting user's own account.
- Bounded, polite retries; duplicate subscriptions are refused.
- Failures are surfaced and notified, never silent.
