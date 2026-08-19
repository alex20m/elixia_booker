# Elixia Booker

Books your group fitness classes at [Elixia](https://www.elixia.fi) (SATS Group)
the moment booking opens.

**TypeScript · Next.js · Neon (Postgres + Auth) · Vercel · GitHub Actions** — all
on free tiers.

You deploy it once. After that anyone you share the URL with creates an account,
links their gym login, picks their classes, and is done.

👉 **[SETUP.md](SETUP.md) is the step-by-step guide.** Start there.

---

## ⚠️ One thing is missing: the Elixia API itself

Everything here works **except** the calls to Elixia, which have never been
observed — the discovery run needs a real browser and your own 2FA, on your
machine. See [docs/api.md](docs/api.md#why-it-is-blank).

So `lib/elixia.ts` is a placeholder. **It is the only file containing guesses.**
Until it is filled in, the app runs against a built-in mock (`MOCK_ELIXIA=1`),
which makes every other layer — accounts, encryption, scheduling, cron,
notifications, history — fully usable and testable today.
[SETUP.md step 10](SETUP.md#10-replace-the-mock-with-the-real-elixia-api) covers
replacing it.

---

## Two logins, on purpose

Your **Booker account** (Neon Auth) is separate from your **Elixia
credentials**, which you link afterwards.

That is not ceremony for its own sake. If sign-in went through Elixia directly,
app access would be hostage to an API nobody has verified: were Elixia's login an
OAuth redirect, or always 2FA-gated, nobody could sign in at all — not even to
find out. Separating them means the app works regardless, and Neon Auth handles
email verification, password reset and session refresh instead of hand-rolled
cookie code.

### What is stored, and how

- **Your Booker password** — never seen by this app. Neon Auth handles it.
- **Your Elixia password** — kept, **encrypted with AES-256-GCM** under a key
  that lives only in the app's environment, never in the database. A database
  dump is inert without it.
- **Elixia session tokens** — sealed in the same record.

Keeping the gym password is a deliberate trade-off, not laziness: the bot runs
unattended for weeks, and re-authenticating is the only way to survive a session
finally expiring without emailing you to come and re-link. The UI says so
plainly, and unlinking erases it.

Isolation between users is enforced by the server, which is the only thing
holding a database connection: the browser talks to `/api/*`, never to Postgres,
and every statement the repo issues is scoped to the signed-in user's id. That
predicate is load-bearing rather than decorative, so `tests/neonRepo.test.ts`
runs the real schema against real Postgres and checks that one account cannot
read, pause or delete another's rows.

---

## How the booking works

GitHub Actions fires the tick every minute:

1. **Look up.** One indexed range scan over precomputed release instants.
   Nothing due → immediate exit.
2. **Verify.** The schedule is derived data; live subscriptions are the
   authority, so a paused class is dropped.
3. **Prepare.** Decrypt the credentials, refresh or re-authenticate, resolve the
   class id — all *before* the sleep.
4. **Sleep** to the exact release millisecond.
5. **Book**, retrying with jittered exponential backoff inside a ~30s budget,
   clamped by the serverless function's own deadline. Permanent outcomes — full,
   already booked, credentials rejected — stop the loop at once.
6. **Waitlist** only after the class is confirmed full, and only if asked.
7. **Record and notify.**

A nightly job reprojects every account's releases and prunes old ones.

### Why GitHub Actions rather than Vercel Cron

Vercel's Hobby plan runs cron jobs **once a day**, which is useless for booking
that opens at an exact minute. GitHub Actions has minute granularity and is free.
Its schedules are queued rather than punctual, so the handler claims a release
from a minute either side of now and then sleeps to the exact instant — a
slightly late trigger still books on time, and every attempt logs its offset from
T-0 so a genuinely late one is visible rather than a mystery.

### The timing detail that matters

"7 days before" is a claim about the **wall clock in Helsinki**, not elapsed
time. Subtracting `7 × 24h` from the class instant is wrong twice a year: an hour
early each spring (a wasted run) and **an hour late each autumn** — by which
point a popular class is gone.

`lib/schedule.ts` does the arithmetic on the calendar and resolves back through
the zone. It also handles a release landing in the skipped spring-forward hour
(shifted forward) and one landing in the repeated autumn hour (resolved to the
earlier instant, because being early is recoverable and being late is not).

---

## Layout

```
app/                    Next.js App Router
  page.tsx              the dashboard (client component)
  handler/[...stack]    Neon Auth's own pages: sign in, reset, account settings
  api/…/route.ts        JSON API — thin: authenticate, call a service, serialise
  api/cron/tick         the booking tick, secret-guarded
lib/
  schedule.ts           DST-correct release-instant maths
  planner.ts            weekly recurrence → concrete releases
  service.ts            the app's behaviour, independent of HTTP and Postgres
  booking.ts, retry.ts  the critical path and its bounded retry loop
  auth/crypto.ts        AES-GCM sealing of stored credentials
  auth/stack.ts         Neon Auth (Stack) server app
  db/                   Repo interface + Neon and in-memory implementations
  elixia.ts             ⚠️ the only file with unverified assumptions
  mock.ts               stand-in backend so the app runs before discovery
db/schema.sql           tables, indexes, constraints, cascades
.github/workflows/      CI/CD, the every-minute tick, the nightly reindex
discovery/              local-only Playwright capture (never deployed)
```

The `Repo` interface is why moving storage — Workers KV, then Redis, now
Postgres — has never required touching the booking logic.

---

## Tests

```bash
npm test           # 248 tests, no services required
npm run typecheck
npm run lint
npm run build
```

Covering the DST-aware release maths and its edge cases, the weekly planner, the
retry loop's bounds and host-deadline clamping, encryption at rest, cron
authorisation, per-user isolation, the schedule and its cascade behaviour,
response classification, dry-run mode, and discovery-capture redaction. The
in-memory repo reproduces the constraints the real schema enforces — the
duplicate-class unique index and cascade-on-delete — so a fake that is more
permissive than production cannot hide bugs.

These were not merely observed passing. The suite has been re-run against
twenty-six deliberate mutations across this and previous revisions — naive epoch
subtraction, DST edges resolved the wrong way, a fixed AES nonce, an
unauthenticated cron endpoint, a prefix-matched secret, the host deadline ignored
— and each was caught.

Six real bugs surfaced that way and are fixed:

- a retry budget a slow request could overshoot, and a hanging request that was
  unbounded entirely;
- redaction collapsing a whole subtree and destroying the structure the capture
  exists to document;
- `TOO_EARLY`-style error codes falling through to a generic error, because the
  markers read as English while the codes are SCREAMING_SNAKE_CASE;
- nothing stopping a user adding the same class twice, which would have raced two
  requests for one slot at T-0;
- a deadline-clamp test that could not fail, because the mock booked on the first
  attempt and the retry loop was never reached;
- the cron endpoint loading configuration *before* checking authorisation, so an
  anonymous request got a 500 describing the deployment instead of a flat 401.

Verified beyond the unit tests: built and served as a production Next.js app,
driven through the browser with Playwright in both themes and at phone width,
with the persisted data inspected directly to confirm no plaintext credential is
written.

### The pipeline

`.github/workflows/ci.yml` runs those same four commands on every push and pull
request, then — only on a green `main` — builds and deploys to Vercel and waits
for the live `/api/health` to answer before calling the deploy good. Pull
requests get a preview deployment under the same gate.

Deploying is opt-in: without the `VERCEL_*` secrets those steps skip with a note
rather than failing, so the checks still protect a fork's pull request. See
[SETUP.md step 7](SETUP.md#let-ci-deploy-for-you-optional).

Because no human reviews these merges, the pipeline's own shape is tested too:
`tests/workflows.test.ts` asserts that the deploy jobs wait on the checks, that
only the `main` job carries `--prod`, and that a deploy never cancels mid-flight.
Those assertions were each confirmed to fail against a workflow edited to break
them.

---

## Design constraints

- **No browser at runtime.** Playwright is local-discovery-only and never enters
  the app's dependency graph.
- **Each user acts only on their own account.** Enforced by row-level security,
  not just by application code.
- **Bounded and polite.** ~30s per slot, jittered backoff, `Retry-After`
  honoured, requests aborted at the deadline, permanent failures stop the loop,
  and duplicate subscriptions are refused so the app never races itself.
- **Fail loudly.** Credentials that stop working mark the account, surface in the
  UI, and notify — never a silent no-op.
