# Setup

Everything needed to get Elixia Booker running, in order. About 20 minutes.

**Every step here is a command.** The handful of things a provider gates on a
human are collected under [Has to be done by hand](#has-to-be-done-by-hand), so
the rest runs top to bottom for anyone — or any agent — holding the tokens.

Neon is provisioned **through Vercel**, so Vercel is the single place your
configuration lives, including for local development. Nothing below asks you to
copy a connection string.

Free tiers cover all of it: **Vercel** (hosting), **Neon** (Postgres + auth),
**GitHub Actions** (the every-minute cron), optionally **Telegram**.

> **The one gap:** Elixia's API has never been observed, so the code that talks
> to it is a placeholder. Everything below works today against a built-in mock.
> [Step 10](#10-replace-the-mock) replaces it. Until then leave `MOCK_ELIXIA=1`.

---

## 1. Get the code

```bash
git clone https://github.com/<you>/elixia_booker.git
cd elixia_booker
npm install
npm test          # no services needed
```

If the tests pass, anything that breaks later is configuration, not code.

---

## 2. Create the Vercel project

```bash
npx vercel login                # browser device flow, once
npx vercel link --yes           # creates the project and .vercel/project.json
```

`--yes` accepts the defaults. To attach an **existing** project, name it:
`npx vercel link --yes --project <name> --team <slug>` — `--yes` on its own
silently creates a *new* project from the directory name rather than finding the
one you meant, and the first sign that happened is a deployment with none of
your variables.

A token from **Account Settings → Tokens** (`export VERCEL_TOKEN=…`) replaces
the login step and makes every `vercel` command below unattended.

You can deploy now if you like. Nothing is configured yet, so the app comes up
and says so rather than crashing — missing configuration is reported on the page
and by `/api/health`, never by a failed build.

---

## 3. Add Neon Postgres

```bash
npx vercel integration add neon --name elixia-db
```

One command installs the Marketplace integration, provisions the database,
connects it to the linked project and pulls the variables into `.env.local`.
Pick a region near you — every booking makes a round trip to it, and at T-0 that
latency is on the critical path:

```bash
npx vercel integration add neon --help                    # regions and plans
npx vercel integration add neon --metadata region=<slug>
```

> If it stops to ask you to accept the integration's terms, that step needs a
> human: `npx vercel integration accept-terms neon`, then re-run.

Vercel writes the connection details into Production, Preview **and**
Development. The app reads `DATABASE_URL` (pooled) only; `DATABASE_URL_UNPOOLED`
and the `POSTGRES_*`/`PG*` aliases are for other tools. Nothing to re-paste when
Neon rotates a password — Vercel updates them in place.

### Create the tables

```bash
npx vercel env pull .env.local   # brings DATABASE_URL down from Vercel
npm run migrate
```

That is the only time you migrate by hand. From here on **every Vercel build
migrates before it deploys** — `vercel.json` sets the build command to
`npm run migrate && next build`, so a failed migration fails the build and the
previous deployment keeps serving. Preview deployments get their own Neon
branch, and their build migrates that branch too.

### Changing the schema later

Add a file — `db/migrations/0002_add_waitlist_position.sql` — and never edit one
that has run. Migrations are tracked **by file name**, so editing an applied one
changes nothing and renaming it runs it again. Two constraints `npm test`
checks for you:

- **Compatible with the code already live.** The migration runs while the
  *previous* deployment is still serving. Add nullable columns; leave renames
  and drops to a follow-up PR.
- **One transaction**, so no `begin`/`commit` and nothing Postgres refuses
  inside one (`create index concurrently`) — apply those by hand.

Two consequences: a deploy needs the database reachable to succeed, and rolling
a deployment back does not roll the schema back.

### Turn on Neon Auth

```bash
npx neonctl neon-auth enable --project-id "$NEON_PROJECT_ID" --branch main
npx neonctl neon-auth config email-password --project-id "$NEON_PROJECT_ID"
npx neonctl neon-auth status --project-id "$NEON_PROJECT_ID" --output json
```

`NEON_PROJECT_ID` is already in `.env.local` from the pull above. Enabling auth
pushes `NEON_AUTH_BASE_URL` into the same Vercel project — check with
`npx vercel env ls`, and if it is missing, read it out of `status --output json`
and add it as in [step 5](#5-add-the-remaining-variables-in-vercel).

This is the **current** Neon Auth — managed Better Auth, not the older Stack
Auth integration (`@stackframe/stack`, `NEXT_PUBLIC_STACK_*`), which is closed
to new projects and is what most tutorials still describe. Accounts live in
`neon_auth.users_sync` in this same database. Sign-in, sign-up, verification and
password reset are served at `/auth/*` and `/account/*`, which is why this app
has no password form of its own.

The cookie-signing secret is **yours to generate**, not something Neon
provisions — that is the next step.

---

## 4. Generate your secrets

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -base64 32)
NEON_AUTH_COOKIE_SECRET=$(openssl rand -base64 32)
```

Keep all three; the next steps and GitHub Actions need the same values.

- **`ENCRYPTION_KEY`** seals every stored Elixia credential, and is the only
  thing making a leaked database dump inert. Nothing provisions it, and the app
  refuses to serve a signed-in request without it. **Lose or change it and every
  user must re-link their gym account** — by design.
- **`CRON_SECRET`** authenticates the booking tick. Without it the endpoint
  would be publicly triggerable.
- **`NEON_AUTH_COOKIE_SECRET`** signs the session cookie. Must be 32+
  characters, or the app treats Neon Auth as unconfigured.

---

## 5. Add the remaining variables in Vercel

Neon supplied the database and auth variables. These are the ones only you can
supply:

```bash
add() { printf '%s' "$2" | npx vercel env add "$1" production,preview,development; }

add ENCRYPTION_KEY               "$ENCRYPTION_KEY"      # step 4
add CRON_SECRET                  "$CRON_SECRET"         # step 4
add NEON_AUTH_COOKIE_SECRET      "$NEON_AUTH_COOKIE_SECRET"
add MOCK_ELIXIA                  1                      # 0 after step 10
add DRY_RUN                      1                      # 0 to really book
add DEFAULT_BOOKING_WINDOW_DAYS  7                      # 7 Basic, 14 Premium
add DEFAULT_TIMEZONE             Europe/Helsinki
```

Including `development` matters: that is the set `vercel env pull` gives you
next, so the same values serve local dev. Confirm with `npx vercel env ls`.

**Redeploy afterwards.** Vercel does not apply new variables to an existing
build, so until you do, the deployment behaves exactly as if you never set them.

---

## 6. Run it locally

```bash
npx vercel env pull .env.local
npm run dev
```

`vercel env pull` writes the **Development** values into `.env.local`, which is
gitignored. Re-run it whenever a variable changes; nothing here is edited by
hand.

Development `DATABASE_URL` points at the same Neon branch as production. To keep
local dev off real data, create a branch in the Neon console, point the
Development variable at it, and pull again.

At <http://localhost:3000>:

1. **Create an account** — your Booker login, separate from Elixia.
2. **Link your Elixia account** — with `MOCK_ELIXIA=1`, any email containing `@`
   and any password of 4+ characters is accepted.
3. **Add a class** and check the "Opens …" time looks right.

Fire a booking run by hand:

```bash
curl -X POST http://localhost:3000/api/cron/tick \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## 7. Deploy

```bash
npx vercel deploy --prod
curl https://<your-app>.vercel.app/api/health
```

Every field should read `true` except `apiDiscovered` (step 10) — including
**`encryptionConfigured`**, which is the one that is false on a deployment that
otherwise looks fine and where sign-in fails with "Could not load your account".

Then let Neon Auth link back to the deployment:

```bash
npx neonctl neon-auth domain add "https://<your-app>.vercel.app" --project-id "$NEON_PROJECT_ID"
```

Without it, confirmation and password-reset emails point at `localhost`. Add
your preview domain too if you want sign-in on previews.

### How deploying works

**Vercel's Git integration deploys; GitHub Actions only checks.** Once the
project is linked (step 2), Vercel builds every pull request as a preview and
every push to `main` as production — no GitHub-side configuration, no `VERCEL_*`
token anywhere. The **Pull request** and **Main** workflows lint, typecheck,
test and build; neither deploys and neither migrates, and
`tests/workflows.test.ts` fails if either starts to, because a second route to
production deploys every merge twice and silently undoes rollbacks.

So a red **Main** run means the commit is broken *and already live*. The
pull-request run is the real gate.

### Custom domain (optional)

Domain and DNS at Cloudflare, app on Vercel. Attach first, then read the record
Vercel wants rather than hardcoding it:

```bash
npx vercel domains add booker.example.com elixia_booker
npx vercel domains inspect booker.example.com     # the record to create
```

Cloudflare has no DNS CLI, so create the record through its API with a token
scoped to **Zone → DNS → Edit** on that zone:

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

- **`"proxied": false`.** Orange-clouding puts Cloudflare's proxy in front of a
  host that already terminates TLS; the symptoms — a certificate that never
  issues, or a redirect loop — do not point back at the toggle.
- **Re-running the `POST` fails** rather than updating. Look the record up by
  name and `PATCH` it if it exists, or a second run of your setup dies halfway.
- `verify` failing immediately afterwards is normal — DNS propagation. Re-run it
  in a few minutes.

Then point `APP_URL` (step 8) at the custom domain and add it as a Neon Auth
trusted domain exactly as above.

---

## 8. Set up the cron (GitHub Actions)

Vercel's Hobby plan runs cron jobs once a day, which is useless for booking that
opens at an exact minute. GitHub Actions has minute granularity and is free for
public repositories. The workflows are already in
[`.github/workflows/`](.github/workflows/) — **Booking cron** every minute, and
**Nightly reindex**, which reprojects upcoming releases so the tick stays a
single indexed scan. Both use the same two secrets:

```bash
gh secret set APP_URL     --body "https://<your-app>.vercel.app"   # no trailing slash
gh secret set CRON_SECRET --body "$CRON_SECRET"                    # same value as Vercel

gh workflow run "Booking cron" && gh run watch
```

**Run it once rather than trusting the list.** `gh secret list` shows a secret
that exists, not one that has a value — setting one from an empty variable
stores an empty string that lists identically, and the failure surfaces later as
every scheduled run failing with `APP_URL and CRON_SECRET repository secrets
must be set`.

Two things worth knowing:

- **Scheduled workflows are queued, not punctual**, and GitHub can delay them by
  minutes under load. The handler claims a release from a minute either side of
  now and sleeps to the exact instant, so a slightly late trigger still books on
  time. Every attempt logs its offset from T-0.
- **Scheduled workflows are disabled after 60 days** of repository inactivity.
  Any commit re-enables them.

Alternatives that work unchanged: [cron-job.org](https://cron-job.org), or
Vercel Pro, whose own cron then works via `crons` in `vercel.json`.

---

## 9. Telegram notifications (optional)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Add `TELEGRAM_BOT_TOKEN` to Vercel and redeploy.
3. Message your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
4. Paste that chat ID into **Settings** in the app.

One bot serves everyone; each user supplies their own chat ID. Without it the
app still books and logs — it just can't tell you about it.

---

## 10. Replace the mock

Everything above works against `lib/mock.ts`. This is the step that books real
classes, and it has to happen on your own machine: it needs a real login, which
means a real browser and your own 2FA.

```bash
cp .env.example .env         # add ELIXIA_EMAIL / ELIXIA_PASSWORD
npx playwright install chromium

npm run discover:headed      # walks login → schedule → booking
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

If the browser succeeds and `curl` fails, **stop** — the premise is dead. A
serverless function can't run a JS challenge or control its TLS fingerprint, so
no amount of endpoint detail helps and the architecture needs rethinking. Better
to find out in five minutes than after a week.

If it succeeds:

1. Fill in [`docs/api.md`](docs/api.md) from the capture.
2. Update `lib/elixia.ts`: `ENDPOINTS`, `authHeaders`, `buildBookingBody`,
   `parseLoginResponse`, `classifyBookingResponse`, `resolveClassId`.
3. Set `API_DISCOVERED = true` there.
4. Set `MOCK_ELIXIA=0` in Vercel and redeploy.
5. Leave `DRY_RUN=1` for one booking window and check the history shows a
   plausible attempt at the right millisecond.
6. Set `DRY_RUN=0`.

---

## Has to be done by hand

Everything else is a command. These are gated on a human by the provider:

- **`npx vercel login`, or minting a Vercel token** — browser device flow, once
  per machine.
- **Minting `NEON_API_KEY` and `CLOUDFLARE_API_TOKEN`** — a token cannot create
  itself.
- **Accepting a Marketplace integration's terms**, if the CLI asks.
- **Registering the domain and pointing its nameservers at Cloudflare**, for a
  custom domain.
- **Creating the Telegram bot** — BotFather is a chat, and your chat ID exists
  only once you have messaged it.
- **Elixia discovery (step 10)** — a real login with real 2FA is the point.

---

## Checklist

- [ ] `npm test` passes locally
- [ ] Vercel project linked, and it is the project you meant
- [ ] Neon provisioned and `DATABASE_URL` visible in `npx vercel env ls`
- [ ] `npm run migrate` run once against Neon
- [ ] Neon Auth enabled, `NEON_AUTH_BASE_URL` in Vercel, app URL added as a
      trusted domain
- [ ] `ENCRYPTION_KEY`, `CRON_SECRET`, `NEON_AUTH_COOKIE_SECRET` and the app
      settings added for Production, Preview and Development — **then redeployed**
- [ ] `/api/health` reports everything `true` but `apiDiscovered`,
      `encryptionConfigured` included
- [ ] `vercel env pull .env.local` works and `npm run dev` comes up configured
- [ ] `APP_URL` and `CRON_SECRET` set on GitHub, **verified by a manual run**
- [ ] **Pull request** and **Main** green, Vercel's Git deploys left enabled
- [ ] Account created, gym account linked, one class added
- [ ] Discovery done, `MOCK_ELIXIA=0`, one dry-run window observed
- [ ] `DRY_RUN=0`

---

## Troubleshooting

**"Could not load your account" after signing in** — sign-in worked and
`/api/me` did not. The message on screen is the server's own; act on that.
Nearly always `ENCRYPTION_KEY is not set`, because nothing provisions it (step
4). Add it, then **redeploy**; locally, re-pull `.env.local` and restart
`npm run dev`. `/api/health` names it as `encryptionConfigured`.

**"Neon Auth is not configured"** — `NEON_AUTH_BASE_URL` or
`NEON_AUTH_COOKIE_SECRET` is missing, or the secret is under 32 characters.
Check both with `npx vercel env ls`.

**A variable is set in Vercel but the app disagrees** — the running deployment
was built before you added it. Redeploy. Nothing applies a new variable to an
existing build, and locally nothing updates a `.env.local` you have not
re-pulled.

**The cron workflow fails**, by message:

| Message | Cause |
| --- | --- |
| `secrets must be set` | `APP_URL` or `CRON_SECRET` is empty on GitHub — an empty secret lists the same as a real one |
| `401` | `CRON_SECRET` differs between GitHub and Vercel |
| `500` naming `CRON_SECRET` | it isn't set in Vercel; the endpoint refuses rather than allow an unauthenticated booking |

**The workflow stopped running** — GitHub disables scheduled workflows after 60
days of inactivity. Push any commit.

**Confirmation link points at localhost** — add your deployed URL as a Neon Auth
trusted domain (step 7).

**A change to a migration had no effect** — migrations are tracked by file name,
so one that has run never runs again however much you edit it. Put the change in
a new migration, including when it fixes the previous one.

**A preview is missing a column the branch adds** — its Neon branch was cut
before the migration merged. Redeploy the preview.

**A preview has no data** — expected. Each preview gets its own Neon branch,
with your schema but not your rows.

**Local dev can't reach the database** — `.env.local` is stale or predates the
variables. Re-pull. If `DATABASE_URL` is still absent, the Neon variables aren't
ticked for Development in Vercel.

**"No database configured" banner** — the app fell back to in-memory storage
because `DATABASE_URL` is missing. Data will not survive.

**A booking was missed** — check the history entry's offset from T-0. A large
positive number means the trigger arrived late (GitHub queueing); `too-early`
across every retry means the release time is computed wrong, so check membership
tier and timezone in Settings.

**Everything works but nothing is really booked** — expected while
`MOCK_ELIXIA=1` or `DRY_RUN=1`. Both are shown as banners in the app.
