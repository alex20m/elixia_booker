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

**If your migrations are plain `.sql` files, you need v9 and one option.** The
default loader imports each migration as a module, which is right for `.ts`
migrations and nonsense for SQL — it needs `migrationLoaderStrategies`, which
does not exist before `node-pg-migrate@9`. Pinning v7 from memory typechecks
as "unknown property" and is easy to misread as your config being wrong. Driving
the runner from a small script rather than the bare CLI is what lets you set it,
along with the two options worth having:

```ts
await runner({
  databaseUrl,                 // the UNPOOLED url — see below
  dir: 'db/migrations',
  direction: 'up',
  migrationLoaderStrategies: [{ extensions: ['.sql'], loader: 'legacySql' }],
  checkOrder: true,            // refuse a migration numbered below one already applied
  advisoryLockMode: 'wait',    // queue behind a run in flight rather than failing
});
```

`checkOrder` catches the shape a merge conflict takes when two branches each add
"the next" migration; `advisoryLockMode: 'wait'` is what makes two deploys
landing together serialise instead of one losing. That is still configuration,
not a runner of your own — the moment the wrapper grows retries or a ledger, the
wrong tool was picked.

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

- **Always pass `--project <name>` explicitly, especially in a fresh worktree.**
  `vercel link --yes` with no `.vercel/project.json` on disk and no `--project`
  does not fail or prompt — it silently *creates a new project* named after the
  current directory. A parallel-task worktree (its directory is never the
  repo's name — see `isolated-task-branch`) is exactly the situation with no
  cached link, so this fires every time unless named explicitly. If it happens
  anyway, `npx vercel project ls` shows the stray project and `npx vercel
  project rm <name>` (needs a piped `y`, or `--non-interactive` plus the
  --yes-equivalent flag your CLI version supports) removes it — safe as long as
  it has no deployments or data yet.
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

#### Those preview branches accumulate, and the quota failure lies about itself

Nothing deletes a preview branch when its pull request merges. They pile up one
per branch ever previewed, and every plan caps how many may exist — a free tier
in the small handful, where a repo with a few merged PRs reaches the ceiling
within days.

**What makes this expensive is the symptom, which points at the wrong layer.**
Provisioning the database happens *before* the build container starts, so the
platform reports the failure as a build failure: a red deploy check, a generic
"resource provisioning failed", and a build that lasted `0ms`. There are **no
build logs at all**, because nothing was ever built. The natural reading is
that the commit broke the build, and the natural response is to go hunting
through a diff that is entirely innocent.

Three signals separate this from a real build failure, and all three are
cheap:

- **Zero build events.** Not "the logs look short" — the log endpoint returns
  nothing, because no build ran.
- **Production still deploys fine.** Production uses the long-lived parent
  branch and provisions nothing, so it is unaffected. Previews failing while
  production succeeds is close to diagnostic on its own.
- **It is not specific to one branch.** Check whether previews on *other*
  branches also started failing, and when. A per-branch cause cannot explain a
  project-wide onset.

The fix is to delete the branches belonging to merged or abandoned work — never
the default branch, which is the parent everything else is seeded from:

```bash
<provider-cli> branches list  --project-id "$PROJECT_ID" --output json
<provider-cli> branches delete "<branch>" --project-id "$PROJECT_ID"
```

Then re-trigger the failed deployment; it will provision and build normally.

Worth doing once as housekeeping and then *not* relying on memory: the quota
refills silently and fails the same confusing way next time. If the integration
offers automatic cleanup on branch deletion, turn it on. Otherwise put the
delete command in SETUP.md next to the preview-database note, so the person who
meets the 0ms build has somewhere to find it.

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

**Verified against `@neondatabase/auth@0.5.0-beta`**, published 2026-08-11.
Check the version before trusting the surface below — it is pre-1.0 and
beta-tagged, its dependency on `better-auth` is pinned to an exact version, and
the package ships its own `llms.txt`, which is the fastest primary source there
is. When the provider's docs site is unreachable, `npm pack @neondatabase/auth`
and read `package/llms.txt` out of the tarball: that is the README the version
you are actually installing ships with, which beats any search result.

```bash
npm install @neondatabase/auth        # add @neondatabase/auth-ui for prebuilt components
```

Two variables, both required:

```bash
NEON_AUTH_BASE_URL=https://<your-project>.neon.tech
NEON_AUTH_COOKIE_SECRET=<at least 32 characters>     # openssl rand -base64 32
```

Server side, one instance is the entry point for everything:

```ts
// lib/auth/server.ts
import { createNeonAuth } from '@neondatabase/auth/next/server';

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});

// app/api/auth/[...path]/route.ts
export const { GET, POST } = auth.handler();

// middleware.ts
export default auth.middleware({ loginUrl: '/auth/sign-in' });

// a server component
export const dynamic = 'force-dynamic';
const { data: session } = await auth.getSession();
```

Client side, `createAuthClient()` from `@neondatabase/auth/next`, and the vanilla
client takes the auth URL directly. A React SPA installs `@neondatabase/neon-js`
instead and reads `VITE_NEON_AUTH_URL`.

Nine things that bite:

- **The catch-all segment must be `[...path]`.** The handler reads `params.path`,
  so any other name routes nothing. The package's own JSDoc example says
  `[...all]` while its types say `path` — the types are what runs.
- **`NEON_AUTH_COOKIE_SECRET` is yours to generate**, unlike the variables the
  integration supplies, and `createNeonAuth` **throws** below 32 characters.
  That throw is why you should build the instance lazily rather than at module
  scope: at module scope it fails the *build* of a project that has not
  provisioned auth yet, instead of failing the request that needed it.
- **Importing the SDK pulls in `next/headers`**, which exists only inside a Next
  runtime — so anything importing it cannot be unit-tested under a plain node
  test environment. Keep the logic worth testing (mapping their session onto
  yours, reading the variables) in a module that does *not* import the SDK, and
  let the SDK module be thin wiring.
- **An anonymous caller is `{ session: null, user: null }`**, an explicit null
  rather than an absent field. Treating "no `user` key" as signed-out makes a
  malformed response indistinguishable from a signed-out visitor.
- **Server components that touch `auth` need `export const dynamic =
  'force-dynamic'`.** Sessions come from cookies, which only exist at request
  time; without it the page is prerendered and the user is always logged out.
- **`@neondatabase/auth-ui`'s provider themes the whole document**, so the root
  layout needs `suppressHydrationWarning` on `<html>`. `NeonAuthUIProvider`
  wraps its children in next-themes' `ThemeProvider` (`attribute: "class"`,
  `enableSystem`), and next-themes ships a blocking script that stamps
  `class="dark"` and `style="color-scheme: dark"` onto `document.documentElement`
  before React hydrates. The server markup can never carry those — the theme
  lives in `localStorage` and the OS setting — so every dark-mode visitor gets a
  hydration mismatch on `<html>`. The symptom accuses the layout, which is
  innocent; the cause is a transitive dependency of a provider mounted deep in
  the body, and no amount of reading the layout reveals it. Verified against
  `@neondatabase/auth-ui@0.3.0-beta`. `suppressHydrationWarning` applies to the
  one element it is set on and **not** its subtree, so real mismatches inside the
  page are still reported — which is why it belongs on `<html>` and nowhere else.
  The same holds for any provider that themes the document rather than its own
  subtree.
- **Add the deployed URL as a trusted domain** as soon as the app has one.
  Skipping it is a delayed failure: sign-up works, but confirmation and
  password-reset links point at localhost, and only the developer fails to
  notice.
- **A proxy in front of a hosted auth service must not let `fetch` follow the
  redirect**, or the session it just minted is lost. This is the shape: the
  provider's SDK mounts a catch-all route that forwards each request upstream
  with a plain `fetch` and re-signs the upstream `Set-Cookie` onto *your*
  origin — that re-signing is the whole reason the proxy exists. But
  `fetch` follows redirects by default and exposes only the final response, so
  when an endpoint answers `302 + Set-Cookie` — which is exactly what an email
  verification or confirmation link does — the cookie is set on a hop nobody
  can read and the browser gets the *body of the redirect target* instead. The
  visitor lands back on the app signed out, on the page they had just
  clicked their way past, and has to sign in by hand. Nothing errors, and
  reading the proxy explains nothing, because the bug is in a default.
  The fix depends on which side you can move. Better Auth decides between a
  redirect and JSON purely on whether the request carries a `callbackURL`, and
  it sets the session cookie *before* that branch — so stripping `callbackURL`
  from the request before forwarding it gets the same verification back as a
  200 with the cookie intact, leaving your own route to issue the redirect
  (`303`, so it is followed as a `GET`) with those cookies attached. Where you
  cannot change the request, `redirect: 'manual'` on the upstream fetch is the
  general version of the same move. Either way, send the browser to the UI
  library's own callback view rather than to `/`: that view refetches the
  session and announces the change before forwarding on, which is what stops
  the destination from rendering as signed-out until a manual reload. Verified
  by reading `better-auth@1.6.23`'s `api/routes/email-verification` and
  `@neondatabase/auth@0.5.0-beta`'s proxy; when a flow "works but the user
  isn't signed in afterwards", read the endpoint's source for that
  redirect-versus-JSON branch before anything else.
- **Account deletion is not in the proxy — the managed instance has no
  `/delete-user` route.** Better Auth only registers that endpoint when
  `user.deleteUser.enabled` is set in the *server* config, which you cannot set
  on a managed instance, so `authClient.deleteUser()` (and the UI library's
  `DeleteAccountCard`, which calls it) comes back **404**. The supported path is
  the Neon Console API, and it is **branch-scoped** because `neon_auth` is a
  per-branch schema: `DELETE https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth/users/{id}`
  with `Authorization: Bearer $NEON_API_KEY`. Resolve the branch from
  `GET .../projects/{id}/branches` (the one with `"default": true`) unless you
  already hold its id. Two knock-on costs: the API key is one you **mint by hand**
  in the Neon console — the Vercel integration supplies `NEON_PROJECT_ID` but not
  a key — so deletion has a manual setup step the rest of auth does not; and
  because there is no upstream success to react to, the catch-all route has to
  intercept `delete-user` itself and do the app's own cleanup there — purge your
  data *after* the identity call returns, and **clear the session explicitly**,
  since `auth.getSession()` trusts the signed session-data cookie without calling
  upstream and would otherwise keep the deleted user "signed in" until it
  expired. Verified against `@neondatabase/auth@0.5.0-beta` and the Neon API
  docs, 2026-09.

Managed Better Auth is documented as **AWS regions only** (no Azure), and as not
supporting projects with IP Allow or Private Networking enabled. Confirm against
your project before designing around it.

```bash
npx neonctl neon-auth enable  --project-id <id> --branch <branch>
npx neonctl neon-auth status  --project-id <id> --output json    # read variable names back
npx neonctl neon-auth domain add https://<your-app-url> --project-id <id>
npx neonctl neon-auth oauth-provider add --project-id <id>       # google, github, …
```

Read the variable names back from `status --output json` rather than assuming
them. They are what the app imports, and a wrong guess builds clean and fails at
sign-in.

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

## The GitHub "homepage" field silently tracks the Production domain

Vercel's GitHub App writes the connected repo's About-section **Website**
field (`homepage` in the GitHub API) to whatever the project's Production
deployment currently resolves to, and it does this again on later production
deploys — not just at project creation. If the project didn't have a verified
custom domain configured as its **Production** domain at the time, that write
is a throwaway `*.vercel.app` URL, and it keeps coming back:

- **Editing the field by hand doesn't stick.** The next production
  deploy/promote re-syncs it from the project, so a manually-cleared or
  manually-corrected `homepage` is a symptom fix, not a real one — it reverts
  on the next push to the production branch.
- **Fix the domain, not the field.** Confirm the project actually has a
  verified, non-redirect domain bound to the *Production* environment before
  touching GitHub at all:
  ```bash
  curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/<project>/domains" | jq .
  # want: verified: true, redirect: null, gitBranch: null
  ```
  `redirect` non-null means it's an alias/redirect domain, not the real
  target; `gitBranch` set means it's scoped to a branch deploy, not
  Production. Either one means the GitHub sync will still pick up something
  other than the real domain.
- **Only after that**, set the GitHub field and it will hold:
  ```bash
  gh api repos/<owner>/<repo> -X PATCH -f homepage=https://<domain>
  ```
  Verify it holds by forcing a fresh production deploy (`vercel redeploy
  <deployment-id-or-url> --target production` works without a new commit) and
  re-reading `homepage` afterward — a sync that fires and writes the correct
  domain confirms the fix; a sync that fires and reverts to `*.vercel.app`
  means the domain still isn't attached to Production despite what the
  dashboard implies.
- **No separate per-project toggle for this was found.** Checked against
  Vercel's `Git settings` and `Deploying GitHub Projects with Vercel` docs and
  the full `GET /v9/projects/{id}` response (CLI `vercel@59.10.0`, August
  2026) — no field resembling "sync homepage" or "update repository URL"
  exists in either. The behavior reads as an inherent side effect of the
  GitHub App's `Administration: Write` permission, not a switch. This wasn't
  confirmed against the live dashboard UI itself (only docs + API), so a
  dashboard-only checkbox that isn't documented or exposed via API can't be
  fully ruled out — if one turns up, getting the Production domain right is
  still the fix that has to happen first regardless, since an undocumented
  toggle would only suppress the symptom the same way clearing the field by
  hand does.

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

- **Neon Auth is moving.** The surface above was read out of
  `@neondatabase/auth@0.5.0-beta` itself rather than from documentation, so it
  was accurate for that version — but pre-1.0 and beta-tagged means it can move
  again. Check the installed version's own `llms.txt` before wiring an app to
  it, and `neon-auth status --output json` for the variable names.
- **Environment variable names supplied by an integration** are set by the
  provider and have changed before. Read them back from the CLI instead of
  copying them from here.
- **DNS targets for the hosting platform** are deliberately not written down
  above, for the same reason. `domains inspect` is the source of truth.
- **`neonctl` against a platform-managed resource** is the shakiest link in
  the chain: it depends on the API key being able to see a project the hosting
  platform owns. If a future setup finds a clean CLI path to that key, that is
  worth adding here.
