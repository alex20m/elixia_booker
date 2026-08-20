# Setup

Everything needed to get Elixia Booker running, in order. Roughly 20 minutes.

This guide assumes **Neon is connected through Vercel** — Postgres is
provisioned as a Vercel Marketplace integration, and Vercel keeps the connection
details in sync as environment variables. That means there are no connection
strings to copy by hand, and Vercel is the single place your configuration
lives, including for local development.

**Everything here is a command.** The few things that genuinely cannot be done
from a terminal are collected under [Has to be done by
hand](#has-to-be-done-by-hand); the rest of this guide runs top to bottom for
anyone — or any agent — holding the tokens.

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
npx vercel login                # browser device flow, once
npx vercel link --yes           # creates the project and .vercel/project.json
```

`--yes` accepts the defaults; add `--project <name> --team <slug>` to link an
existing project without any prompts. Once you have a token from **Account
Settings → Tokens**, `export VERCEL_TOKEN=…` replaces the login step and every
`vercel` command below runs unattended.

You can deploy right away if you like — nothing is configured yet, so the app
will come up and say so rather than crash. Missing configuration is reported on
the page and by `/api/health`, never by a failed build.

---

## 3. Add Neon Postgres from Vercel

```bash
npx vercel integration add neon --name elixia-db
```

One command installs the Marketplace integration, provisions the database,
connects it to the linked project and pulls the new variables into
`.env.local`. Pick a region near you — every booking request makes a round trip
to it, and at T-0 that latency is on the critical path:

```bash
npx vercel integration add neon --help                    # regions and plans
npx vercel integration add neon --metadata region=<slug>
```

> If it stops and asks you to accept the integration's terms, that one step
> needs a human at a real terminal: `npx vercel integration accept-terms neon`,
> then re-run. Creating the database from **Project → Storage → Create Database
> → Neon** in the dashboard is equivalent.

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

You only do this once by hand — from here on, **every Vercel build migrates
before it deploys**. `vercel.json` sets the build command to `npm run migrate &&
next build`, so the schema is in place before the new code serves a single
request, and a migration that fails fails the build: the previous deployment
keeps serving rather than being replaced by code its schema cannot support.

Neon branches copy their parent's schema, so the per-deployment branch each
Vercel preview gets already has these tables, and writes from a preview never
touch your real data. Because the preview's build migrates that branch too, a
pull request that adds a column gets it in its own preview.

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

- **Each migration has to be compatible with the code already live.** The
  migration runs during the build, while the *previous* deployment is still
  serving every request, and it is still serving for as long as the build takes
  after that. New code never meets an old schema, but old code does meet the new
  one. Add nullable columns; leave renames and drops to a follow-up PR merged
  once the new code is everywhere.
- **The run happens inside one transaction**, so a migration may not contain
  `begin`, `commit`, or anything Postgres refuses to run in a transaction
  (`create index concurrently`). Apply those by hand. `npm test` checks the
  first part for you.

Two consequences of migrating in the build worth knowing: the database has to be
reachable for a deploy to succeed at all, and rolling a deployment back in
Vercel does not roll the schema back — `node-pg-migrate up` only ever applies
what is outstanding. That is the same restore-from-branch decision as before,
just worth saying out loud.

### Turn on Neon Auth

This app is on the **current** Neon Auth — managed Better Auth, not the older
Stack Auth integration (`@stackframe/stack`, `NEXT_PUBLIC_STACK_*`). Identity
lives in the `neon_auth` schema of this same database rather than a separate
project, so users are queryable in SQL and a Neon branch carries its own
accounts.

```bash
npx neonctl neon-auth enable --project-id "$NEON_PROJECT_ID" --branch main
npx neonctl neon-auth config email-password --project-id "$NEON_PROJECT_ID"
npx neonctl neon-auth status --project-id "$NEON_PROJECT_ID" --output json
```

`NEON_PROJECT_ID` is already in `.env.local` from step 3 (Vercel pulled it in
alongside `DATABASE_URL`). Enabling Neon Auth pushes one more variable into the
same Vercel project:

| Neon calls it | You'll use it as |
| --- | --- |
| Auth base URL | `NEON_AUTH_BASE_URL` |

Check it landed with `npx vercel env ls`. If it didn't, read it out of the
`status --output json` above and add it with `vercel env add` as in
[step 5](#5-add-the-remaining-variables-in-vercel) — the rest of the setup is
identical either way.

The app also needs a cookie-signing secret, which is **yours to generate**
rather than something Neon provisions — see [step
4](#4-generate-your-secrets), which is where `NEON_AUTH_COOKIE_SECRET` is
created alongside the app's other secrets.

Neon Auth owns the accounts directly in `neon_auth.users_sync` in this
database. This app never reads that table — it only needs the user id, which
arrives with the session — but it is there if you ever want to join user
emails onto your own tables in SQL.

Sign-in, sign-up, email verification and password reset are served by Neon
Auth itself at `/auth/*` and `/account/*`, which is why this app has no
password form of its own.

---

## 4. Generate your secrets

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -base64 32)
NEON_AUTH_COOKIE_SECRET=$(openssl rand -base64 32)
```

Keep all three — the next steps and GitHub Actions need the same values. What
they do:

- **`ENCRYPTION_KEY`** seals every stored Elixia credential. It is the only
  thing that makes a leaked database dump inert. **If you lose or change it,
  every user must re-link their gym account** — that is by design, not a bug.
- **`CRON_SECRET`** is the shared secret GitHub Actions sends to trigger a
  booking run. Without it the endpoint would be publicly triggerable.
- **`NEON_AUTH_COOKIE_SECRET`** signs the session cookie Neon Auth issues.
  Unlike `NEON_AUTH_BASE_URL` this is not something Neon provisions — it must
  be at least 32 characters, or the app treats Neon Auth as unconfigured.

---

## 5. Add the remaining variables in Vercel

Neon supplied the database and auth variables. These are the ones only you can
supply. `vercel env add` takes the value on stdin, so each is one line:

```bash
add() { printf '%s' "$2" | npx vercel env add "$1" production,preview,development; }

add ENCRYPTION_KEY               "$ENCRYPTION_KEY"
add CRON_SECRET                  "$CRON_SECRET"
add NEON_AUTH_COOKIE_SECRET      "$NEON_AUTH_COOKIE_SECRET"
add MOCK_ELIXIA                  1
add DRY_RUN                      1
add DEFAULT_BOOKING_WINDOW_DAYS  7
add DEFAULT_TIMEZONE             Europe/Helsinki
```

What each one is:

| Variable | Value |
| --- | --- |
| `ENCRYPTION_KEY` | from step 4 |
| `CRON_SECRET` | from step 4 |
| `NEON_AUTH_COOKIE_SECRET` | from step 4 |
| `MOCK_ELIXIA` | `1` for now |
| `DRY_RUN` | `1` at first |
| `DEFAULT_BOOKING_WINDOW_DAYS` | `7` or `14` |
| `DEFAULT_TIMEZONE` | `Europe/Helsinki` |

Including `development` matters: that is the set `vercel env pull` gives you in
the next step, so the same values serve local dev without a second copy to
maintain. Confirm with `npx vercel env ls`.

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

```bash
npx neonctl neon-auth domain add "https://<your-app>.vercel.app" --project-id "$NEON_PROJECT_ID"
```

Confirmation and password-reset emails link back here; without it they point at
`localhost` and appear broken to everyone but you. Add your preview domain too
if you want sign-in to work on preview deployments.

### Point a custom domain at it (optional)

Domain registered at Cloudflare, DNS at Cloudflare, app on Vercel. Attach the
domain first, then ask Vercel which record it wants — the target changes, so
read it rather than hardcoding it:

```bash
npx vercel domains add booker.example.com elixia_booker
npx vercel domains inspect booker.example.com     # the record to create
```

Cloudflare has no CLI for DNS records, so this part goes through its API with a
token scoped to **Zone → DNS → Edit** on that one zone (**My Profile → API
Tokens → Create Token**):

```bash
export CLOUDFLARE_API_TOKEN=<scoped token>
ZONE=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=example.com" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[0].id')

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"booker","content":"<target from inspect>",
           "ttl":1,"proxied":false}'

npx vercel domains verify booker.example.com
```

Two things to get right:

- **`"proxied": false`.** Orange-clouding the record puts Cloudflare's proxy in
  front of a host that already terminates TLS, and the symptoms — a certificate
  that never issues, or a redirect loop — do not point back at the toggle.
  Leave it grey.
- **Re-running the `POST` fails** rather than updating. Look the record up by
  name and `PATCH` it if it already exists, otherwise a second run of your
  setup dies halfway.

Then point `APP_URL` (step 8) at the custom domain, and add it as a Neon Auth
trusted domain exactly as you did for the `vercel.app` URL. Verification depends
on DNS propagation, so `verify` failing right afterwards is normal — re-run it
in a few minutes.

### How deploying works

**Vercel's Git integration deploys; GitHub Actions only checks.** Once the
project is linked to the repository (step 2), Vercel builds every pull request
as a preview and every push to `main` as production — no secrets, no
configuration on the GitHub side. Leave it enabled and there is nothing to set
up here.

Two workflows run alongside it and lint, typecheck, test and build: **Pull
request** on every pull request, and **Main** on every push to `main`. Neither
deploys, and neither migrates — `vercel.json` makes the build itself
`npm run migrate && next build`, so the schema lands before the deployment that
needs it serves anything (step 3).

Three things that follow from that:

- **The pull-request run is the real gate.** A red **Main** run means the commit
  is broken *and already live*, because Vercel deployed it the moment it landed.
  Merge on green, and treat **Main** as the record of what landed.
- **Do not add a deploy step to the workflows.** A second route to production
  makes every merge deploy twice, racing itself, and a rollback made in Vercel
  is silently undone by the next Actions deploy. `tests/workflows.test.ts` fails
  if one appears.
- **Do not move migrations back into a workflow.** A workflow and the deploy
  both start from the same push, so nothing orders them — the point of putting
  the migration in the build is that Vercel promotes a deployment only if its
  build succeeded. The same test fails if a workflow starts migrating.

Deployments use the environment variables set in Vercel (step 6), which is also
how the build reaches the database to migrate it, and how a preview picks up the
Neon branch Vercel created for it. Nothing there needs duplicating as a GitHub
secret — no `VERCEL_*` token is needed anywhere, and the two GitHub secrets this
repo does use, `APP_URL` and `CRON_SECRET`, are for the booking cron in step 8,
not for deploying.

---

## 8. Set up the cron (GitHub Actions)

Vercel's Hobby plan runs cron jobs **once a day**, which is useless for booking
that opens at an exact minute. GitHub Actions has minute granularity and is free
for public repositories, so it drives the tick instead. The workflows are already
in [`.github/workflows/`](.github/workflows/).

```bash
gh secret set APP_URL     --body "https://<your-app>.vercel.app"
gh secret set CRON_SECRET --body "$CRON_SECRET"
```

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://<your-app>.vercel.app` (no trailing slash) |
| `CRON_SECRET` | the same value you put in Vercel in step 5 |

Then trigger it once rather than waiting for the schedule:

```bash
gh workflow run "Booking cron"
gh run watch
```

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

## Has to be done by hand

Everything else above is a command. These are the exceptions, and each is here
because the provider gates it on a human rather than because a CLI is missing:

- **`npx vercel login`, or minting a Vercel token** — a browser device flow,
  once per machine. After that, everything else on Vercel is scriptable.
- **Minting `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN`** — a token cannot create
  itself, so the first one of each comes from that provider's console.
- **Accepting a Marketplace integration's legal terms**, if the CLI asks:
  `vercel integration accept-terms` requires an interactive terminal and human
  confirmation by design.
- **Registering the domain and pointing its nameservers at Cloudflare**, if you
  want a custom domain.
- **Creating the Telegram bot** — BotFather is a chat, and your chat ID only
  exists once you have messaged the bot.
- **Elixia discovery (step 10)** — a real login with real 2FA in a headed
  browser is the entire point of that step.

---

## Checklist

- [ ] `npm test` passes locally
- [ ] Vercel project created and linked (`npx vercel link`)
- [ ] Neon provisioned (`npx vercel integration add neon`) and `DATABASE_URL`
      visible in `npx vercel env ls`
- [ ] `npm run migrate` run against the Neon database
- [ ] Neon Auth enabled (`neonctl neon-auth enable`), `NEON_AUTH_BASE_URL`
      present in Vercel, and your app URL added as a trusted domain
- [ ] `ENCRYPTION_KEY`, `CRON_SECRET`, `NEON_AUTH_COOKIE_SECRET` and the app
      settings added in Vercel for Production, Preview and Development, then
      redeployed
- [ ] `vercel env pull .env.local` works and `npm run dev` comes up configured
- [ ] `/api/health` reports everything configured
- [ ] Custom domain added and `npx vercel domains verify` clean, if you want
      one, with the Cloudflare record left unproxied
- [ ] `APP_URL` and `CRON_SECRET` set as GitHub Actions secrets
- [ ] **Pull request** and **Main** workflows green, and Vercel's automatic Git
      deploys left enabled
- [ ] **Booking cron** workflow run manually and green
- [ ] Account created, gym account linked, one class added
- [ ] Discovery done, `MOCK_ELIXIA=0`, one dry-run window observed
- [ ] `DRY_RUN=0`

---

## Troubleshooting

**"Neon Auth is not configured"** — `NEON_AUTH_BASE_URL` or
`NEON_AUTH_COOKIE_SECRET` is missing, or the secret is under 32 characters.
Enabling Neon Auth pushes `NEON_AUTH_BASE_URL` into Vercel, but only into the
project the Neon database is attached to; `NEON_AUTH_COOKIE_SECRET` is never
provisioned for you (step 4) — check both are there with `npx vercel env ls`,
add whichever is missing, and **redeploy**. Locally, re-run `npx vercel env
pull .env.local` and restart `npm run dev`; both are read at request time, not
baked in at build time, so a stale `.env.local` is the usual cause.

**Confirmation link points at localhost** — add your deployed URL as a trusted
domain in Neon Auth (step 7).

**A change to a migration had no effect** — migrations are tracked by file
name, so one that has already run is never applied again, however much you edit
it. Put the change in a new migration, including when it is a fix for the
previous one.

**A preview deployment is missing a column the branch adds** — expected. Its
Neon branch was cut from production before the migration merged, and the
preview build applies migrations to it — so redeploy the preview to pick it up.

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
