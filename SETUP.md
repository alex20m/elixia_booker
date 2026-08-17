# Setup

Everything needed to get Elixia Booker running, in order. Roughly 20 minutes.

All four services have free tiers that comfortably cover this: **Neon**
(Postgres + Neon Auth), **Vercel** (hosting), **GitHub Actions** (the
every-minute cron), and optionally **Telegram** (notifications).

> **Before you start, know the one gap:** Elixia's API has never been observed,
> so the code that talks to it is a placeholder. The app runs today against a
> built-in mock, which is enough to set everything up and see it work end to
> end. [Step 8](#8-replace-the-mock-with-the-real-elixia-api) covers replacing
> it. Until then, leave `MOCK_ELIXIA=1`.

---

## 1. Get the code

```bash
git clone https://github.com/<you>/elixia_booker.git
cd elixia_booker
npm install
npm test          # 236 tests, no services needed
```

If the tests pass, the toolchain is fine and anything that breaks later is
configuration rather than code.

---

## 2. Create the Neon project

1. Sign up at [neon.tech](https://neon.tech) and create a project. Pick a region
   near you — every booking request makes a round trip to it, and at T-0 that
   latency is on the critical path.
2. Copy the **pooled** connection string it offers you (it contains `-pooler`).
   That is `DATABASE_URL`. The unpooled one works too, but the pooled endpoint is
   what a serverless deployment wants.
3. Create the tables, either by pasting
   [`db/schema.sql`](db/schema.sql) into the Neon console's SQL editor, or:

   ```bash
   psql "$DATABASE_URL" -f db/schema.sql
   ```

   That creates four tables with their indexes and cascades. It is safe to
   re-run.

### Turn on Neon Auth

In your Neon project, open **Auth** and enable it. Neon provisions a Stack Auth
project wired to this database and shows you three values:

| Neon calls it | You'll use it as |
| --- | --- |
| Project ID | `NEXT_PUBLIC_STACK_PROJECT_ID` |
| Publishable client key | `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY` |
| Secret server key | `STACK_SECRET_SERVER_KEY` |

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

## 3. Generate your secrets

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

## 4. Run it locally

```bash
cat > .env.local <<'EOF'
DATABASE_URL=postgresql://…@ep-….neon.tech/neondb?sslmode=require
NEXT_PUBLIC_STACK_PROJECT_ID=…
NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=pck_…
STACK_SECRET_SERVER_KEY=ssk_…
ENCRYPTION_KEY=<from step 3>
CRON_SECRET=<from step 3>
MOCK_ELIXIA=1
DRY_RUN=1
DEFAULT_BOOKING_WINDOW_DAYS=7
DEFAULT_TIMEZONE=Europe/Helsinki
EOF

npm run dev
```

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

`.env.local` is gitignored.

---

## 5. Deploy to Vercel

```bash
npx vercel          # link the project
npx vercel deploy --prod
```

Or import the repo at [vercel.com/new](https://vercel.com/new).

Then add the environment variables under **Project → Settings → Environment
Variables** (Production *and* Preview):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | from step 2 |
| `NEXT_PUBLIC_STACK_PROJECT_ID` | from step 2 |
| `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY` | from step 2 |
| `STACK_SECRET_SERVER_KEY` | from step 2 |
| `ENCRYPTION_KEY` | from step 3 |
| `CRON_SECRET` | from step 3 |
| `MOCK_ELIXIA` | `1` for now |
| `DRY_RUN` | `1` at first |
| `DEFAULT_BOOKING_WINDOW_DAYS` | `7` or `14` |
| `DEFAULT_TIMEZONE` | `Europe/Helsinki` |

Redeploy after adding them — Vercel does not apply new variables to an existing
build.

Check it came up:

```bash
curl https://<your-app>.vercel.app/api/health
```

Every field should read `true` except `apiDiscovered` (see step 8).

### Add your app URL to Neon Auth

In the Neon console under **Auth → Domains**, add your Vercel URL as a trusted
domain. Confirmation and password-reset emails link back here; without it they
point at `localhost` and appear broken to everyone but you.

### Let CI deploy for you (optional)

The **CI/CD** workflow lints, typechecks, tests and builds every push and pull
request.
Give it three more secrets and it also deploys: a preview for each pull request,
and production for each push to `main` — but only after those checks pass, and
only if the deployed app then answers `/api/health`.

| Secret | Where to get it |
| --- | --- |
| `VERCEL_TOKEN` | Vercel → **Account Settings → Tokens** |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `npx vercel link` |
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
  runs `vercel pull` before building, so the table above stays the single place
  those values live.

If `APP_URL` is set (step 6), the post-deploy check uses it rather than the
one-off deployment URL, which can sit behind Vercel's deployment protection.

---

## 6. Set up the cron (GitHub Actions)

Vercel's Hobby plan runs cron jobs **once a day**, which is useless for booking
that opens at an exact minute. GitHub Actions has minute granularity and is free
for public repositories, so it drives the tick instead. The workflows are already
in [`.github/workflows/`](.github/workflows/).

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**, add two:

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://<your-app>.vercel.app` (no trailing slash) |
| `CRON_SECRET` | the same value you gave Vercel |

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

## 7. Telegram notifications (optional)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Add `TELEGRAM_BOT_TOKEN` to Vercel and redeploy.
3. Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`.
4. Paste that chat ID into **Settings** in the app.

One bot serves everyone; each user supplies their own chat ID. Without it the app
still books and logs — it just can't tell you about it.

---

## 8. Replace the mock with the real Elixia API

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
- [ ] `db/schema.sql` run against the Neon database
- [ ] Neon Auth enabled, and your app URL added as a trusted domain
- [ ] All environment variables set in Vercel, then redeployed
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

**"Neon Auth is not configured"** — `NEXT_PUBLIC_*` variables are missing.
They're baked in at build time, so you must **redeploy** after adding them;
setting them on an existing deployment does nothing.

**The build fails with "Invalid project ID"** — `NEXT_PUBLIC_STACK_PROJECT_ID`
is malformed rather than absent. Re-copy it from the Neon console.

**Confirmation link points at localhost** — add your deployed URL as a trusted
domain in Neon Auth (step 5).

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
