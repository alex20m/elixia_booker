# Elixia Booker

Books your group fitness classes at [Elixia](https://www.elixia.fi) (SATS Group)
the moment booking opens.

**TypeScript · Next.js · Neon (Postgres + Auth) · Vercel · GitHub Actions** — all
on free tiers.

You deploy it once. After that anyone you share the URL with creates an account,
links their gym login, picks their classes, and is done.

---

## The Elixia API is discovered

`lib/elixia.ts` speaks the real thing — login, schedule listing and booking —
implemented from captured traffic and written up in [docs/api.md](docs/api.md).
A mock backend (`MOCK_ELIXIA=1`) is still there for local work and tests.

Three findings are worth knowing before reading any further, because each one
is the opposite of what the app originally assumed:

- **Sign-in is cookies, not tokens.** Elixia delegates to a SATS Group Keycloak
  realm over a plain OAuth2 redirect chain, and the session is four cookies
  lasting 14 days. There is no bearer token and no refresh endpoint.
- **A full class is not a rejection.** One `POST /api/book` either books you or
  puts you on the waiting list, and says which. There is no waitlist flag to
  set and no way to decline a waiting-list place — so the app books, and counts
  a place in the queue as success.
- **A class does not exist until its window opens.** It is absent from the
  schedule rather than refused, so "too early" means *resolution* failing, not
  a booking error — which is why the class id is resolved again at T-0 if it
  could not be resolved ahead of time.

**One thing discovery could not settle:** whether the booking call works from
outside a browser at all. Everything observed says yes, but a browser capture
cannot prove the absence of a JS challenge or TLS fingerprinting. The first
live run is that test.

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
- **The centre you last chose a class from** — kept in plain text so the
  chooser can start there next time. Not the class: that is the decision being
  made each time, and a prefilled one is a subscription nobody meant to
  create.

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

The booking watcher (`.github/workflows/watch.yml`) fires the tick precisely.
One tick does:

1. **Look up.** One indexed range scan over precomputed release instants.
   Nothing due → immediate exit.
2. **Verify.** The schedule is derived data; live subscriptions are the
   authority, so a paused class is dropped.
3. **Prepare.** Decrypt the credentials, re-authenticate if the session has
   lapsed, and try to resolve the class id — all *before* the sleep.
4. **Sleep** to the exact release millisecond.
5. **Book**, retrying with jittered exponential backoff inside a ~30s budget,
   clamped by the serverless function's own deadline. If the class was not
   resolvable earlier — because it was not on the schedule yet — resolution is
   retried here too, and counts as "too early" until it succeeds. Permanent
   outcomes (overlapping booking, credentials rejected) stop the loop at once.
6. **Record and notify** — booked or waitlisted, both are success.

A nightly job reprojects every account's releases and prunes old ones.

### Why GitHub Actions rather than Vercel Cron

Vercel's Hobby plan runs cron jobs **once a day**, which is useless for booking
that opens at an exact minute. GitHub Actions has minute granularity and is
free — but its own schedules are documented as *queued, not punctual*, and
under load a trigger can land late enough that a release falls outside even a
generous claim window and is simply missed, not just fired late.

That is why timing does not depend on a scheduled trigger landing on time at
all. **The booking watcher** (`watch.yml`) is a single long-running job, and
GitHub caps any one job at ~6 hours — there is no way to make a job run
forever. Instead a new job starts every 3 hours and each one runs for up to
~5h50m, so a job is always already running well before the previous one's
deadline. Once running, it asks `/api/cron/next` for the next unclaimed
release and sleeps to it using the runner's own accurate clock, not GitHub's
scheduler — the schedule trigger only has to land sometime in that ~2h50m
overlap, not on the second, for a watcher to always be awake. `claimDue`
claims a release atomically (`CLAIM_LEASE_MS` in `lib/db/repo.ts`), because
the watcher's own loop can otherwise re-fire a release it just booked on its
next iteration; a claim that is never finished — a crashed invocation —
becomes reclaimable rather than lost. Every attempt still logs its offset
from T-0.

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
  api/cron/next         peeks the next unclaimed release, for the watcher to sleep to
lib/
  schedule.ts           DST-correct release-instant maths
  planner.ts            weekly recurrence → concrete releases
  service.ts            the app's behaviour, independent of HTTP and Postgres
  booking.ts, retry.ts  the critical path and its bounded retry loop
  auth/crypto.ts        AES-GCM sealing of stored credentials
  auth/stack.ts         Neon Auth (Stack) server app
  db/                   Repo interface + Neon and in-memory implementations
  elixia.ts             the Elixia adapter — login, listing, booking
  mock.ts               stand-in backend for local work and tests
db/migrations/          numbered schema migrations, applied once each
db/migrate.ts           `npm run migrate` — node-pg-migrate, configured
.github/workflows/      the checks, the booking watcher, the nightly reindex
```

The `Repo` interface is why moving storage — Workers KV, then Redis, now
Postgres — has never required touching the booking logic.

---

## Tests

```bash
npm test           # the full suite, no services required
npm run typecheck
npm run lint
npm run build
```

Covering the DST-aware release maths and its edge cases, the weekly planner, the
retry loop's bounds and host-deadline clamping, encryption at rest, cron
authorisation, per-user isolation, the schedule and its cascade behaviour,
response classification, and dry-run mode. The
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
driven through a headless browser in both themes and at phone width,
with the persisted data inspected directly to confirm no plaintext credential is
written.

### The pipeline

Two workflows run those same four commands: `.github/workflows/pull-request.yml`
on every pull request, and `.github/workflows/main.yml` on every push to `main`.
Neither deploys — **Vercel's Git integration is the only route to production**,
building each pull request as a preview and each push to `main` as production,
on its own.

That makes the pull-request run the gate that actually holds: by the time
`main.yml` goes red, Vercel has already deployed the commit. Merge on green, and
read the `main` run as the record of what landed rather than as a barrier.

Schema migrations ride the deploy rather than racing it. `vercel.json` sets the
build command to `npm run migrate && next build`, so every deployment migrates
before it serves anything, and a failed migration fails the build and leaves the
previous deployment in place. Nothing in Actions migrates, which is also why no
workflow needs a Vercel token.

Because no human reviews these merges, the pipeline's own shape is tested too:
`tests/workflows.test.ts` asserts that both workflows install from the lockfile
and run all four checks, that each triggers on its own event alone, and that
neither deploys, migrates, nor carries Vercel credentials — a second route to
production would race Vercel's and silently undo a rollback. It also asserts the
ordering itself: that the build command runs the migration first and joins the
two with `&&` rather than `;`, so a failed migration cannot be built over. Those
no-op assertions match nothing by design, so further tests prove each detector
still fires against a workflow that *does* deploy or migrate. Every assertion was
confirmed to fail against a workflow or config edited to break it.

---

## Design constraints

- **No browser anywhere.** The adapter reaches Elixia with plain `fetch` — the
  login chain and the schedule page are both parseable without one, which is
  what makes booking from a serverless function possible at all.
- **Each user acts only on their own account.** Every statement the repo issues
  names the user, and `tests/neonRepo.test.ts` proves it against real Postgres.
- **Bounded and polite.** ~30s per slot, jittered backoff, `Retry-After`
  honoured, requests aborted at the deadline, permanent failures stop the loop,
  and duplicate subscriptions are refused so the app never races itself.
- **Fail loudly.** Credentials that stop working mark the account, surface in the
  UI, and notify — never a silent no-op.
