---
name: cli-first-provisioning
description: >-
  Stand up an app's hosting, database, auth and custom domain from the command
  line, so the setup is reproducible and an agent can run it unattended. Use
  when starting a new app project, when wiring one to Vercel, Neon or
  Cloudflare, when choosing and setting up authentication, when deciding what
  the CI workflows should and should not do,
  when writing or updating SETUP.md, and whenever a setup step exists only as a
  sequence of dashboard clicks. Covers the order the pieces have to be created
  in, why the platform deploys and CI only checks, driving provider CLIs
  non-interactively, which few steps are genuinely human-only, and verifying
  each step instead of assuming it worked.
---

# Set it up from the command line

A dashboard click is the least reproducible thing in a project. It leaves no
diff, cannot be re-run, cannot be reviewed, cannot be handed to someone else,
and an agent cannot do it at all — so every manual step is a step that gets
done slightly differently the next time, by someone guessing which tab it was
under.

The goal is not "prefer the CLI when convenient". It is that **someone holding
the tokens can run SETUP.md top to bottom without opening a browser**, and the
handful of steps where that is genuinely impossible are listed in one place so
they stay visible and keep shrinking.

## Choosing a route for each step

In order, take the first one that works:

1. **A provider CLI subcommand.** Best: it validates input, prints a real
   error, and usually knows the current defaults.
2. **The provider's REST API with `curl` and a scoped token.** Every provider
   has one, and everything the dashboard does goes through it. Slightly more
   work — you handle JSON and idempotency yourself — but nothing is out of
   reach.
3. **The dashboard.** Only when the credential needed for 1 and 2 does not
   exist yet (the first token has to be minted somewhere), or the provider
   deliberately gates the step on a human: billing, accepting legal terms,
   OAuth consent screens, device attestation.

Route 3 is not a failure, but it is a debt. Write those steps down under one
heading in SETUP.md rather than scattering them through the flow, so the
manual surface is countable and someone can notice when a provider ships a CLI
for one of them.

## Read the CLI's actual surface before you write it down

Provider CLIs move faster than any blog post or model's memory, and a
plausible-looking command that does not exist is worse than no instruction —
it sends whoever runs it hunting for a typo in their own shell.

```bash
npx vercel --help
npx vercel <command> --help          # per-command flags
npx neonctl <command> --help
```

Two habits that pay off:

- **Check subcommand help, not just top-level help.** Interesting flags hide
  one level down (`--metadata`, `--environment`, `--no-env-pull`).
- **Some help is dynamic.** `vercel integration add <name> --help` queries the
  integration and prints *that product's* metadata keys, plans and regions.
  Run it rather than guessing region slugs.

Record the CLI version you verified against next to any non-obvious command in
SETUP.md. When it eventually breaks, the version is what tells the next reader
whether the command was wrong or has simply moved.

## The order the pieces have to be created in

Each step exists because the next one needs something it produces. Doing them
out of order does not fail loudly — it half-works, which is worse.

1. **Repo and app scaffold.** Next.js + TypeScript, tests running, before any
   service exists.
2. **The hosting project, linked from the repo.** This has to come first
   because everything else attaches *to* it: integrations are installed onto a
   project, and environment variables live on it. `vercel link` writes
   `.vercel/project.json`, which is what later commands read to know which
   project they mean.
3. **Database and auth, as an integration on that project.** Provisioning it
   through the platform rather than separately is what makes the connection
   details appear as managed environment variables, kept in sync when they
   rotate — instead of a connection string someone pasted once.
4. **Your own application variables** (secrets you generate, feature flags,
   defaults). Set them for every environment you will use, including
   development, so local dev pulls from the same source of truth.
5. **The git integration, which is what deploys.** Connecting the repo to the
   hosting project is the deploy pipeline: pushes get previews, merges to the
   default branch go to production. Do this before the domain — you need
   something running to point a domain at, and it surfaces build problems while
   the surface is still small.
6. **The custom domain**, pointed at the production deployment.
7. **The checks workflow.** Migrations belong in the build command (above),
   not in a workflow of their own.

## Let the platform deploy; let CI check

The hosting platform's git integration already builds, deploys and promotes on
push. A workflow that also deploys does not add a gate — it adds a second
racing route to production, and every merge ships twice.

So the split is fixed:

- **The platform deploys.** Connect the repo, and leave automatic deploys on.
  Nothing in `.github/workflows` runs `deploy`.
- **CI checks the code.** One workflow on every pull request and push:
  lockfile-exact install, lint, typecheck, test, build. It is what makes a
  merge safe, and it is enforced as a required check rather than by the deploy
  waiting for it.
- **Migrations go in the build, not in a workflow.** A migration workflow
  cannot be ordered against a deploy the platform owns: both start from the
  same push, so new code can be serving before the schema it needs exists.
  Putting the migration inside the build command instead makes the ordering a
  dependency rather than a race — the platform promotes a deployment only if
  its build exited 0, so a failed migration leaves the previous deployment
  serving. On Vercel that is `buildCommand` in `vercel.json`, which also beats
  a Build Command set in the dashboard:

  ```json
  { "buildCommand": "npm run migrate && next build" }
  ```

  `&&` and not `;` — with a semicolon the build proceeds over a failed
  migration, which is the whole failure being designed out. Keep the migration
  out of the plain `build` script, or CI's build check needs a database too.

  The command in front of the `&&` is whatever your migration tool's
  non-interactive form is, and that is the part to check per stack: it has to
  run in a build container with no login and no TTY, taking its target from an
  environment variable the platform already sets. `node-pg-migrate` reads
  `DATABASE_URL`; a Supabase-owned schema wants `supabase db push` pointed at a
  direct connection string rather than a linked project — verify the exact flag
  against that CLI's `--help` before writing it down, because a build command
  that prompts hangs the deploy instead of failing it.

The consequence to design around: **old code meets the new schema.** The
migration runs while the previous deployment is still serving, and that
deployment keeps serving until the build finishes, so migrations still have to
be additive — add a nullable column now, backfill, and drop the old one in a
later change once nothing reads it. Migrating in the build removes the reverse
overlap (new code, old schema); it cannot remove this one, and no arrangement
that keeps the site up can.

Two costs to accept knowingly: the database must be reachable for a deploy to
succeed, and rolling a deployment back does not roll the schema back — `up`
only applies what is outstanding.

See the `deploy-gate` skill for what to assert about these workflows so their
gates cannot quietly disappear.

## Migrations: use the tool, not your own runner

Postgres here means **`node-pg-migrate`**, driven from its CLI. Applying files
in order, recording what ran, checksumming so an edited migration is caught,
locking so two runners cannot race — those are the parts that are easy to write
badly and tedious to test, and they are exactly what the package already did.

```json
"scripts": { "migrate": "node-pg-migrate up", "migrate:new": "node-pg-migrate create" }
```

```bash
npm run migrate:new -- add_waitlist_position   # writes a timestamped file
npm run migrate                                 # applies what is outstanding
```

What stays yours is the migration files and those two npm scripts. If the
wrapper grows logic — retries, ordering, a ledger table of its own — that is the
signal the wrong tool was picked, not that the wrapper needs finishing.

Three things to get right when wiring it up:

- **It needs a direct, unpooled connection string.** Migrations take locks and
  run DDL; the pooled URL the app uses is the wrong one. With a
  platform-provisioned database that is usually a second variable
  (`DATABASE_URL_UNPOOLED` or similar) — point `DATABASE_URL` at it for the
  migration step only.
- **The build runs migrations on every deployment, so they must be re-runnable
  and additive.** `node-pg-migrate up` is idempotent by design; your SQL has to
  be too. Preview builds migrate their own database branch, which is what makes
  a preview of a schema change actually testable.
- **Prefer plain SQL migration files** unless you need the JS API. They are
  reviewable by anyone, and they survive changing the tool.

## Running provider CLIs unattended

Interactivity is the main thing that breaks an agent-run setup, and it breaks
it by hanging rather than by failing.

- **Pass every value as a flag.** Vercel's CLI defaults to
  `--non-interactive` when it detects an agent, which turns a would-be prompt
  into an error. That is the behaviour you want — but it means a command that
  works in your terminal can fail in an agent's, and the fix is always to
  supply the flag it wanted, never to force a TTY.
- **Authenticate with tokens from the environment,** not the browser login
  flow: `VERCEL_TOKEN`, `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`. Mint each with
  the narrowest scope that works (for Cloudflare DNS, `Zone:DNS:Edit` on the
  one zone). Keep them in the environment, out of the repo, and out of command
  output — never `echo` a token to check it is set; test it with a call that
  uses it.
- **Expect a few commands to refuse regardless.** `vercel integration
  accept-terms`, for instance, documents that it needs an interactive terminal
  and human confirmation. When a command says that, it is a genuine route-3
  step: put it in the manual list rather than trying to script around it.
- **Ask for JSON when you need to read a value back.** `--json` / `-o json`
  plus `jq` beats parsing a table that changes shape between versions.

## Hosting and environment variables (Vercel)

```bash
npx vercel link --yes --project <name>          # or --team <slug> --project <name>
npx vercel env add MY_SECRET production,preview,development
npx vercel env pull .env.local                  # development values, gitignored
npx vercel deploy                               # a one-off preview, by hand
```

- **`vercel deploy` is for a one-off, not for production.** Production comes
  from pushing to the default branch. Reaching for `--prod` by hand promotes a
  build the checks never saw.
- `vercel env pull` is what keeps local development from being a second copy of
  the configuration. Re-run it whenever a variable changes; never hand-edit
  `.env.local`.
- **Variables are applied at build time, not to the running deployment.**
  Adding one and not redeploying is the single most common "I set it and it
  did not work". Anything `NEXT_PUBLIC_*` is inlined into the bundle, so it is
  doubly true there.
- `vercel project protection` toggles deployment protection from the CLI.
  Worth knowing because protection on preview deployments is what makes a
  post-deploy health check fail with an authentication page instead of your
  JSON.

## Database and auth (Neon through the platform integration)

One command provisions the database, connects it to the linked project, and
pulls the resulting variables locally:

```bash
npx vercel integration add neon                 # --name, --metadata, --environment
```

Useful flags: `--name` for a predictable resource name, `--metadata KEY=VALUE`
for region and similar (list them with `--help` on that integration),
`--environment` to limit which environments get connected, `--prefix` when a
second database would otherwise collide on `DATABASE_URL`.

What the integration does *not* do is your schema, your branches, or auth —
that is `neonctl`, and it needs an API key that can see the platform-owned
project (`NEON_API_KEY`). If the key you have cannot see it, minting one in the
provider console is the one manual step here.

- **Preview deployments get their own database branch**, seeded from the
  parent's schema but not its rows. A preview with no data is correct
  behaviour, not a broken setup — say so in SETUP.md before someone reports it
  as a bug.

### Neon Auth is managed Better Auth now

This is the trap worth spending a paragraph on: nearly everything written about
"Neon Auth" describes the **older Stack Auth integration** — `@stackframe/stack`,
a `StackProvider`, and `NEXT_PUBLIC_STACK_PROJECT_ID` /
`NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY` / `STACK_SECRET_SERVER_KEY`. That is
the legacy product. It still runs for projects already on it, but it is closed
to new ones, so following a tutorial for it wastes an afternoon before failing.

The current one is **Better Auth, managed by Neon**, and the difference that
matters architecturally is where identity lives: in the `neon_auth` schema of
your own database. Users are a table you can join against and apply row-level
security to, there is no webhook syncing an external user store into yours, and
because it is in the database, **a Neon branch carries its own users** — a
preview environment gets an isolated set of accounts for free.

```bash
npx neonctl neon-auth enable  --project-id <id> --branch <branch>
npx neonctl neon-auth status  --project-id <id> --output json
npx neonctl neon-auth domain add https://<your-app-url> --project-id <id>
npx neonctl neon-auth oauth-provider add --project-id <id>     # google, github, …
npx neonctl neon-auth config email-password --project-id <id>
```

App side, for Next.js:

```bash
npm install @neondatabase/auth@latest @neondatabase/auth-ui
```

```ts
export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
```

One `createNeonAuth()` gives you `auth.getSession()`, `auth.handler()` and
`auth.middleware()`. A React SPA installs `@neondatabase/neon-js` instead and
reads `VITE_NEON_AUTH_URL`.

Four things that bite:

- **`NEON_AUTH_COOKIE_SECRET` is yours to generate**, unlike the other
  variables: `openssl rand -base64 32`, at least 32 characters, and it must be
  set or sessions cannot be signed. Add it with `vercel env add` alongside your
  other secrets.
- **Server components that touch `auth` need `export const dynamic =
  'force-dynamic'`.** Sessions come from cookies, which only exist at request
  time; without it the page is prerendered and the user is always logged out.
- **Read the variable names back from `neon-auth status --output json`** rather
  than assuming them. They are what the app imports, and a wrong guess builds
  clean and fails at sign-in.
- **Add the deployed URL as a trusted domain** as soon as the app has one.
  Skipping it is a delayed failure: sign-up works, but confirmation and
  password-reset links point at localhost, and only the developer fails to
  notice.

### When to use something else

Neon Auth is the default because it is one less service and one less sync. It
is not a requirement. Reach for another provider when the app needs something
it does not do — an identity feature it lacks, SSO your users already have, or
a database that is not Neon — and when you do, say in `SETUP.md` why, and
provision it by CLI like everything else. What is not a good reason is a
tutorial that happened to use something else.

## Custom domain (Cloudflare DNS in front of the host)

Attach the domain to the project, then ask the platform what record it wants
rather than hardcoding a target — published IPs and CNAME targets do change:

```bash
npx vercel domains add <domain> <project>
npx vercel domains inspect <domain>       # the record you actually need
npx vercel domains verify <domain>        # explains what is still wrong
```

Cloudflare has no first-party CLI for DNS records, so this is a route-2 step —
the API with a scoped token:

```bash
ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=<domain>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[0].id')

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"www","content":"<target from inspect>",
           "ttl":1,"proxied":false}'
```

Three things that go wrong here:

- **`"proxied": false` is not optional.** An orange-clouded record puts
  Cloudflare's proxy in front of a host that is already terminating TLS and
  issuing its own certificate. The visible symptoms — certificate issuance
  that never completes, or a redirect loop — do not obviously point back at
  the proxy toggle.
- **Creating a record that already exists is an error, not an update.** Look
  the record up by name first and `PATCH` it if present; otherwise re-running
  your setup script fails halfway through on its second run.
- **An apex domain is fine as a CNAME** — Cloudflare flattens it — but check
  what `domains inspect` asks for before assuming apex and subdomain take the
  same record type.

Verification is DNS-dependent, so it is the one step where "run it again in a
few minutes" is a legitimate answer. `vercel domains verify` tells you which
of the two it is: wrong record, or not propagated yet.

## Verify each step; do not infer success from exit 0

Every step in SETUP.md should end with a command whose output proves the step
worked, because the failure modes here are quiet:

- after variables change → `vercel env ls`, then **redeploy** and check the
  running app, not the dashboard;
- after provisioning → connect to the database and list tables, rather than
  trusting that a variable exists;
- after deploying → hit a health endpoint that reports what is configured, so
  one request answers "did all of this actually take";
- after DNS → `vercel domains verify`, and a real request to the domain over
  HTTPS.

A health endpoint that reports configuration state is worth writing early. It
turns every one of these checks into the same one-line command, and it is what
lets CI gate a deploy on more than "the build exited 0".

## What SETUP.md has to contain

Every app project ships one, and it is the deliverable for the setup work —
not a summary of it. Write it so that **someone holding the tokens, or an
agent, can execute it top to bottom without a browser.** If a step cannot be
written that way, that is precisely the signal it belongs in the manual list.

1. **What this sets up and roughly how long it takes**, in a paragraph, plus
   anything that is knowingly incomplete. Surprises belong at the top, not
   discovered at step 9.
2. **Prerequisites**: accounts needed, CLIs used, and each token with the
   exact scopes it needs.
3. **Numbered steps**, each one a copy-pasteable block plus the check that
   proves it worked. Placeholders in one obvious style (`<like-this>`).
4. **One "has to be done by hand" section**, listing every route-3 step with
   the reason it is manual. This is the list that shrinks over time.
5. **An environment variable table**: name, what it is, and *who supplies it* —
   provider-managed variables and ones you generate are maintained completely
   differently, and confusing them is how someone ends up pasting a rotating
   secret into a second place.
6. **A checklist** of the end state, so a half-finished setup is visible.
7. **Troubleshooting keyed by the error text the reader will actually see**,
   not by subsystem. They are searching the page for the string in front of
   them.

## Where this is least certain

- **Neon Auth is moving.** It was rebuilt on Better Auth, the SDK is young
  (`@neondatabase/auth` was still pre-1.0 when this was written), and the
  package, variable and component names above are the ones that changed last
  time. Treat them as a starting point and check `neon-auth status` and the
  package's own README before wiring an app to them.
- **Environment variable names supplied by an integration** are set by the
  provider and have changed before. Read them back from the CLI instead of
  copying them from here.
- **DNS targets for the hosting platform** are deliberately not written down
  above, for the same reason. `domains inspect` is the source of truth.
- **`neonctl` against a platform-managed resource** is the shakiest link in
  the chain: it depends on the API key being able to see a project the hosting
  platform owns. If a future setup finds a clean CLI path to that key, that is
  worth adding here.
