# Setup

Everything needed to get Elixia Booker running, in order. Roughly 20 minutes.

This guide assumes **Neon is connected through Vercel** — you add Postgres from
your Vercel project's Storage tab, and Vercel keeps the connection details in
sync as environment variables. That means there are no connection strings to
copy by hand, and Vercel is the single place your configuration lives, including
for local development.

All the services have free tiers that comfortably cover this: **Vercel**
(hosting, and where Neon is provisioned), **Neon** (Postgres + Neon Auth),
**GitHub Actions** (the every-minute cron), and optionally **Telegram**
(notifications).

> **Before you start, know the one gap:** Elixia's API has never been observed,
> so the code that talks to it is a placeholder. The app runs today against a
> built-in mock, which is enough to set everything up and see it work end to
> end. [Step 10](#10-replace-the-mock-with-the-real-elixia-api) covers replacing
> it. Until then, leave `MOCK_ELIXIA=1`.

---

## 1. Get the code

```bash
git clone https://github.com/<you>/elixia_booker.git
cd elixia_booker
npm install
npm test          # 248 tests, no services needed
```

If the tests pass, the toolchain is fine and anything that breaks later is
configuration rather than code.

---

## 2. Create the Vercel project

The Vercel project comes first here, because it is what you attach Neon to.

```bash
npx vercel login
npx vercel link     # creates the project and .vercel/project.json
```

Or import the repo at [vercel.com/new](https://vercel.com/new).

You can deploy right away if you like — nothing is configured yet, so the app
will come up and say so rather than crash. Missing configuration is reported on
the page and by `/api/health`, never by a failed build.

---

## 3. Add Neon Postgres from Vercel

In the Vercel dashboard: **your project → Storage → Create Database → Neon**
(under Marketplace Database Providers). Pick a region near you — every booking
request makes a round trip to it, and at T-0 that latency is on the critical
path.

Vercel provisions the Neon project and writes its connection details into your
project's environment variables for **Production, Preview and Development**:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | pooled connection string — **the one this app uses** |
| `DATABASE_URL_UNPOOLED` | direct connection, for tools that need a session |
| `POSTGRES_*`, `PG*` | aliases for other frameworks; this app ignores them |

Nothing to copy, and nothing to re-paste when Neon rotates a password — Vercel
updates them in place. The app reads `DATABASE_URL` only.

### Create the tables

The schema lives in [`db/migrations/`](db/migrations) as numbered `.sql` files.
[node-pg-migrate](https://github.com/salsita/node-pg-migrate) applies each one
once and records it in a `pgmigrations` table. Now that Vercel holds the
connection string, you can apply them from your own machine:

```bash
npx vercel env pull .env.local   # brings DATABASE_URL down from Vercel
npm run migrate
```

That creates four tables with their indexes and cascades. Re-running it applies
nothing and says so.

You only do this once by hand — from here on, **merging to `main` migrates
production automatically**, as part of the same pipeline that deploys (step 7).

Neon branches copy their parent's schema, so the per-deployment branch each
Vercel preview gets already has these tables, and writes from a preview never
touch your real data.

### Changing the schema later

Add a file, never edit one that has run:

```bash
db/migrations/0002_add_waitlist_position.sql
```

Four digits, then lower_snake_case, and the whole file is the migration — no
`up`/`down` markers, because rolling a live schema back is a restore-from-branch
decision rather than a script. Applied migrations are tracked **by file name**,
so editing one that has run changes nothing and renaming one runs it again. A
new file numbered below one that has already run is refused.

Two rules that keep an automatic migration safe:

- **The old code keeps serving while the new code rolls out**, and migrations
  run first, so each one has to be compatible with the version already live:
  add nullable columns, and leave renames and drops to a follow-up PR once the
  new code is everywhere.
- **The run happens inside one transaction**, so a migration may not contain
  `begin`, `commit`, or anything Postgres refuses to run in a transaction
  (`create index concurrently`). Apply those by hand. `npm test` checks the
  first part for you.

A pull request's preview deployment uses a Neon branch cut from production
*before* its migration merged, so a preview that needs a new column will not
have it. Run `npm run migrate` against that branch's connection string if you
need the preview to be complete.

### Turn on Neon Auth

In the Neon console for that database, open **Auth** and enable it. Neon
provisions a Stack Auth project wired to this database and — because the project
is connected to Vercel — pushes three more variables into the same Vercel
project:

| Neon calls it | You'll use it as |
| --- | --- |
| Project ID | `NEXT_PUBLIC_STACK_PROJECT_ID` |
| Publishable client key | `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY` |
| Secret server key | `STACK_SECRET_SERVER_KEY` |

Check they landed under **Vercel → Project → Settings → Environment Variables**.
If they didn't, copy them across from the Neon console by hand — the rest of the
setup is identical either way.

> ⚠️ The **secret server key acts for every user.** It belongs only in
> server-side environment variables. Never give it a `NEXT_PUBLIC_` prefix and
> never paste it into client code.

Neon Auth owns the accounts, and mirrors them into a `neon_auth.users_sync`
table in the same database. This app never reads that mirror — it only needs the
user id, which arrives with the session — but it is there if you ever want to
join user emails onto your own tables in SQL.

Sign-in, sign-up, email verification and password reset are served by Neon Auth
itself at `/handler/*`, which is why this app has no password form of its own.

---

## 4. Generate your secrets

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 32   # CRON_SECRET
```

Keep both. What they do:

- **`ENCRYPTION_KEY`** seals every stored Elixia credential. It is the only
  thing that makes a leaked database dump inert. **If you lose or change it,
  every user must re-link their gym account** — that is by design, not a bug.
- **`CRON_SECRET`** is the shared secret GitHub Actions sends to trigger a
  booking run. Without it the endpoint would be publicly triggerable.

---

## 5. Add the remaining variables in Vercel

Neon supplied the database and auth variables. These are the ones only you can
supply — add them under **Project → Settings → Environment Variables**, ticking
**Production, Preview *and* Development** on each:

| Variable | Value |
| --- | --- |
| `ENCRYPTION_KEY` | from step 4 |
| `CRON_SECRET` | from step 4 |
| `MOCK_ELIXIA` | `1` for now |
| `DRY_RUN` | `1` at first |
| `DEFAULT_BOOKING_WINDOW_DAYS` | `7` or `14` |
| `DEFAULT_TIMEZONE` | `Europe/Helsinki` |

Ticking Development matters: that is the set `vercel env pull` gives you in the
next step, so the same values serve local dev without a second copy to maintain.

Redeploy after adding them — Vercel does not apply new variables to an existing
build.

---

## 6. Run it locally

```bash
npx vercel env pull .env.local
npm run dev
```

`vercel env pull` writes the **Development** values — database, auth, and
everything from step 5 — into `.env.local`, which is gitignored. Re-run it
whenever a variable changes in Vercel; nothing here is edited by hand.

By default the Development `DATABASE_URL` points at the same Neon branch as
production. If you'd rather local dev didn't write to real data, create a branch
in the Neon console and point the Development variable at it, then pull again.

Open <http://localhost:3000>:

1. **Create an account** — this is your Booker login, separate from Elixia.
2. **Link your Elixia account** — with `MOCK_ELIXIA=1`, any email containing `@`
   and any password of 4+ characters is accepted.
3. **Add a class** and check the "Opens …" time looks right.

Trigger a booking run by hand:

```bash
curl -X POST http://localhost:3000/api/cron/tick \
  -H "Authorization: Bearer <your CRON_SECRET>"
```

---

## 7. Deploy to production

```bash
npx vercel deploy --prod
```

Check it came up:

```bash
curl https://<your-app>.vercel.app/api/health
```

Every field should read `true` except `apiDiscovered` (see step 10).

### Add your app URL to Neon Auth

In the Neon console under **Auth → Domains**, add your Vercel URL as a trusted
domain. Confirmation and password-reset emails link back here; without it they
point at `localhost` and appear broken to everyone but you. Add your preview
domain too if you want sign-in to work on preview deployments.

### Let CI deploy for you (optional)

The **CI/CD** workflow lints, typechecks, tests and builds every push and pull
request.
Give it three more secrets and it also deploys: a preview for each pull request,
and production for each push to `main` — but only after those checks pass, and
only if the deployed app then answers `/api/health`.

| Secret | Where to get it |
| --- | --- |
| `VERCEL_TOKEN` | Vercel → **Account Settings → Tokens** |
| `VERCEL_ORG_ID` | `.vercel/project.json` from `npx vercel link` (step 2) |
| `VERCEL_PROJECT_ID` | same file |

Add them under **Settings → Secrets and variables → Actions**. Leave any of them
unset and the deploy steps skip with a note in the run log — the checks still
run, so a fork's pull request is not blocked by secrets it cannot have.

Two things to know before turning it on:

- **Vercel's own Git integration also deploys**, so with both enabled every push
  deploys twice. Pick one: either skip these secrets, or turn the integration's
  automatic deploys off under **Project → Settings → Git** and let the workflow
  be the only route to production.
- **The deploy uses Vercel's environment variables, not GitHub's.** The workflow
  runs `vercel pull` before building, which is also how a preview deployment
  picks up the Neon branch Vercel created for it. Neon's variables never need to
  be duplicated as GitHub secrets.

If `APP_URL` is set (step 8), the post-deploy check uses it rather than the
one-off deployment URL, which can sit behind Vercel's deployment protection.

---

## 8. Set up the cron (GitHub Actions)

Vercel's Hobby plan runs cron jobs **once a day**, which is useless for booking
that opens at an exact minute. GitHub Actions has minute granularity and is free
for public repositories, so it drives the tick instead. The workflows are already
in [`.github/workflows/`](.github/workflows/).

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**, add two:

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://<your-app>.vercel.app` (no trailing slash) |
| `CRON_SECRET` | the same value you put in Vercel in step 5 |

Then **Actions** → enable workflows if prompted → open **Booking cron** → **Run
workflow** to test it immediately rather than waiting.

Two things worth knowing:

- **Scheduled workflows are queued, not punctual.** GitHub can delay them by
  minutes under load. The handler is built for that: it claims a release from a
  minute either side of now and then sleeps to the exact instant, so a slightly
  late trigger still books on time. Every attempt logs its offset from T-0, so a
  genuinely late one is visible rather than a mystery.
- **Scheduled workflows are disabled after 60 days of no repository activity.**
  If the repo goes quiet, GitHub emails you and stops running them. Any commit
  re-enables them.

If you'd rather not depend on that, alternatives that work unchanged:
[cron-job.org](https://cron-job.org) (free, reliable, minute granularity), or
Vercel Pro, whose own cron then works via the `crons` field in `vercel.json`.

---

## 9. Telegram notifications (optional)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Add `TELEGRAM_BOT_TOKEN` to Vercel and redeploy.
3. Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
4. Paste that chat ID into **Settings** in the app.

One bot serves everyone; each user supplies their own chat ID. Without it the app
still books and logs — it just can't tell you about it.

---

## 10. Replace the mock with the real Elixia API

Everything above works today against `lib/mock.ts`. This is the step that makes
it book real classes, and it has to happen on your own machine: the app needs to
watch a real login, which means a real browser and your own 2FA.

```bash
cp .env.example .env         # add ELIXIA_EMAIL / ELIXIA_PASSWORD
npx playwright install chromium

npm run discover:headed      # walks you through login → schedule → booking
npm run redact               # strips secrets, ready to commit
```

**Run the decisive test before writing anything up.** Take a token from the
browser's network tab and replay the booking POST with plain `curl`:

```bash
curl -X POST 'https://<booking-endpoint>' \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"classId":"..."}'
```

If the browser succeeds and `curl` fails, **stop** — the whole premise is dead. A
serverless function can't run a JS challenge and can't control its TLS
fingerprint, so no amount of endpoint detail will help, and the architecture
needs rethinking rather than finishing. Better to find out in five minutes than
after a week of work.

If it succeeds:

1. Fill in [`docs/api.md`](docs/api.md) from the capture.
2. Update `lib/elixia.ts`: `ENDPOINTS`, `authHeaders`, `buildBookingBody`,
   `parseLoginResponse`, `classifyBookingResponse`, `resolveClassId`.
3. Set `API_DISCOVERED = true` in that file.
4. Set `MOCK_ELIXIA=0` in Vercel and redeploy.
5. Leave `DRY_RUN=1` for one booking window and check the history shows a
   plausible attempt at the right millisecond.
6. Set `DRY_RUN=0`.

---

## Checklist

- [ ] `npm test` passes locally
- [ ] Vercel project created and linked (`npx vercel link`)
- [ ] Neon added from Vercel's Storage tab, and `DATABASE_URL` visible in the
      project's environment variables
- [ ] `npm run migrate` run against the Neon database
- [ ] Neon Auth enabled, its three variables present in Vercel, and your app URL
      added as a trusted domain
- [ ] `ENCRYPTION_KEY`, `CRON_SECRET` and the app settings added in Vercel for
      Production, Preview and Development, then redeployed
- [ ] `vercel env pull .env.local` works and `npm run dev` comes up configured
- [ ] `/api/health` reports everything configured
- [ ] `APP_URL` and `CRON_SECRET` set as GitHub Actions secrets
- [ ] **CI/CD** workflow green (and, if you want CI to deploy, the three
      `VERCEL_*` secrets set and Vercel's own auto-deploy turned off)
- [ ] **Booking cron** workflow run manually and green
- [ ] Account created, gym account linked, one class added
- [ ] Discovery done, `MOCK_ELIXIA=0`, one dry-run window observed
- [ ] `DRY_RUN=0`

---

## Troubleshooting

**"Neon Auth is not configured"** — the `NEXT_PUBLIC_*` variables are missing.
Enabling Neon Auth pushes them into Vercel, but only into the project the Neon
database is attached to; check they are there, and add them by hand if not.
They're baked in at build time, so you must **redeploy** after they appear —
setting them on an existing deployment does nothing.

**The build fails with "Invalid project ID"** — `NEXT_PUBLIC_STACK_PROJECT_ID`
is malformed rather than absent. Re-copy it from the Neon console.

**Confirmation link points at localhost** — add your deployed URL as a trusted
domain in Neon Auth (step 7).

**A change to a migration had no effect** — migrations are tracked by file
name, so one that has already run is never applied again, however much you edit
it. Put the change in a new migration, including when it is a fix for the
previous one.

**A preview deployment is missing a column the branch adds** — expected. Its
Neon branch was cut from production before the migration merged. Run
`npm run migrate` against the preview branch, or merge.

**Local dev can't reach the database** — `.env.local` is stale, or was pulled
before the variables existed. Re-run `npx vercel env pull .env.local`. If it
comes back without `DATABASE_URL`, the Neon variables aren't ticked for the
Development environment in Vercel.

**A preview deployment has no data** — expected. Each preview gets its own Neon
branch, with your schema but not your rows.

**The cron workflow fails with 401** — `CRON_SECRET` differs between GitHub and
Vercel. They must match exactly; re-paste both.

**The cron workflow fails with 500 mentioning `CRON_SECRET`** — it isn't set in
Vercel. The endpoint refuses to run rather than allowing an unauthenticated
booking run.

**The workflow stopped running** — GitHub disables scheduled workflows after 60
days of repository inactivity. Push any commit to re-enable.

**"No database configured" banner** — the app fell back to in-memory storage
because `DATABASE_URL` is missing. Data will not survive.

**A booking was missed** — check the history entry's offset from T-0. A large
positive number means the trigger arrived late (GitHub queueing); `too-early`
across every retry means the release time is computed wrong, so check the
membership tier and timezone in Settings.

**Everything works but nothing is really booked** — expected while
`MOCK_ELIXIA=1` or `DRY_RUN=1`. Both are shown as banners in the app.
