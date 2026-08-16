# Elixia API — discovery notes

> ## ⚠️ STATUS: NOT YET DISCOVERED
>
> **Every finding below is blank on purpose.** No discovery run has happened, so
> nothing here has been observed against the live site.
>
> This file is the *questionnaire*, not the answers. It exists so the discovery
> run has a defined shape to fill in, and so nobody downstream mistakes a guess
> for a finding.
>
> See [Why it is blank](#why-it-is-blank) and [How to fill it in](#how-to-fill-it-in).

## What depends on this file

The application is built, tested and deployable. Everything that does *not*
depend on Elixia's API — sign-in, encryption at rest, per-user subscriptions,
release-instant timing, the due index, the cron, retries, notifications,
history, dry-run — is real and covered by tests.

Everything that *does* depend on it lives in one file, `lib/elixia.ts`, whose
values are placeholders. While `API_DISCOVERED = false` the client refuses to
issue live requests, so a misconfigured deploy fails loudly rather than firing
at a guessed endpoint and missing a booking at T-0.

Because that would otherwise make the whole app undemonstrable, a mock backend
(`lib/mock.ts`, enabled with `MOCK_ELIXIA=1`) stands in. Every layer above the
adapter runs its real code path against it.

Once this document is filled in, the work is: update `ENDPOINTS`, `authHeaders`,
`buildBookingBody`, `parseLoginResponse`, `classifyBookingResponse` and
`resolveClassId`; set `API_DISCOVERED = true`; set `MOCK_ELIXIA = "0"`; dry run;
go live.

### One extra question this rewrite raises

The app is multi-user and serverless, so add to the list below: **does Elixia
rate-limit per account or per source IP?** Every user's booking leaves from a
Vercel function, and those share a small pool of egress addresses — so a per-IP
limit would be shared across all users and would need global pacing rather than
the per-user budget that exists today.

Second: **can a session be obtained from a plain server-side POST?** The app now
stores an encrypted password and re-authenticates on its own when a session
lapses. If login requires a browser redirect or is always 2FA-gated, that
recovery path cannot work and linking would have to be redone by hand each time
a session expires — which is worth knowing before anyone relies on it.

**The highest-value section is [§7](#7-anti-bot-signals), not §5.** If the
booking call cannot be reproduced outside a browser, no amount of endpoint
detail rescues the project — so run that test before doing the rest of the
write-up.

---

## Why it is blank

Discovery was attempted from the Claude Code cloud container and could not run.
Three independent blockers, any one of which is sufficient:

1. **No network route to Elixia.** The environment's egress proxy denies the
   host outright — `CONNECT tunnel failed, response 403` for both
   `www.elixia.fi` and `www.sats.fi`. This is the environment's allowlist
   policy, not a misconfiguration, and not something to work around.
2. **No credentials.** `ELIXIA_EMAIL` / `ELIXIA_PASSWORD` are not set, and a
   shared ephemeral cloud container is the wrong place to put a live gym
   account password anyway.
3. **Headed browsing is impossible here, and 2FA needs it.** The container has
   no display anyone can see. "Run it headed the first time so I can clear any
   2FA" requires the browser to be on *your* machine.

Blocker 3 is the structural one: even with network access and credentials, the
first run has to be interactive on the machine of the person who owns the
account. **Discovery is a local task by nature.** The tooling in `discovery/` is
built and ready; it needs to be run by you.

---

## How to fill it in

```bash
git clone <this repo> && cd elixia-booker
npm install
cp .env.example .env         # add ELIXIA_EMAIL / ELIXIA_PASSWORD
npx playwright install chromium

npm run discover:headed      # walks you through login -> schedule -> booking
npm run redact               # safe-to-commit summary in captures/redacted/
```

The capture script tags traffic by phase and pauses between phases, so
`captures/raw/exchanges.jsonl` reads in order: login, then schedule, then
booking. `captures/redacted/endpoint-index.md` gives you the endpoint list to
work from.

Then answer the questions below from what you actually see. Where something
turns out not to exist (no refresh endpoint, no CSRF token), **write "none
observed" rather than deleting the section** — a confirmed absence is a finding
the design depends on.

---

## 1. Login

| Question | Finding |
| --- | --- |
| Login endpoint (method + URL) | _not yet discovered_ |
| Is it Elixia's own domain or a SATS Group / third-party IdP? | _not yet discovered_ |
| Request content type | _not yet discovered_ |
| Request payload shape | _not yet discovered_ |
| Response status + payload shape | _not yet discovered_ |
| Access token returned? Format (JWT / opaque)? | _not yet discovered_ |
| Refresh token returned? | _not yet discovered_ |
| Token lifetime (`exp` claim, `expires_in`, cookie `Max-Age`) | _not yet discovered_ |
| Session cookies set (names, `HttpOnly`, `Secure`, `SameSite`, domain) | _not yet discovered_ |
| Any pre-login handshake (nonce, PKCE, `state`, CSRF seed)? | _not yet discovered_ |
| 2FA/MFA challenge — always, or only on new devices? | _not yet discovered_ |

**Why it matters:** the app exchanges a password for tokens once, at sign-in,
and never stores the password. If login turns out to be a full OAuth/OIDC
redirect dance rather than a JSON POST, that exchange cannot happen server-side
at all — sign-in would have to move into the browser and hand the app the
resulting tokens, which is a different UI and a different threat model.
Establish this first; it gates everything else.

```
Paste the redacted login exchange here.
```

---

## 2. Carrying auth on subsequent requests

| Question | Finding |
| --- | --- |
| Bearer header, cookie, or both? | _not yet discovered_ |
| Exact header name and value format | _not yet discovered_ |
| Any additional required headers (client id, app version, locale, device id)? | _not yet discovered_ |
| Do API calls fail without those extra headers, or are they cosmetic? | _not yet discovered_ |

**Test to run:** replay one schedule request with `curl`, carrying only the
token, then add headers back one at a time until it succeeds. The minimal
working set is what the app should send — nothing more, nothing less. Record
which headers are load-bearing, because guessing wastes a booking window.

---

## 3. Token refresh

| Question | Finding |
| --- | --- |
| Refresh endpoint exists? | _not yet discovered_ |
| Method, URL, payload | _not yet discovered_ |
| Triggered proactively on a timer, or reactively on a 401? | _not yet discovered_ |
| Does refresh rotate the refresh token? | _not yet discovered_ |
| What does a refresh failure look like? | _not yet discovered_ |

**Why it matters:** rotation decides whether the database write must happen
before the booking POST or can be deferred until after. If the refresh token
rotates on every use, a crash between refresh and write orphans the session and
the next tick fires with a dead token — so the write has to come first, at the
cost of a slower critical path. If it does not rotate, the write can safely wait
until after the booking.

---

## 4. Schedule listing

| Question | Finding |
| --- | --- |
| Endpoint (method + URL) | _not yet discovered_ |
| Query parameters (centre, date range, activity type, paging) | _not yet discovered_ |
| How is a centre/club identified? | _not yet discovered_ |
| How is a single class instance identified? Stable across days? | _not yet discovered_ |
| Class start time format — local, UTC, or offset-bearing? | _not yet discovered_ |
| Fields for capacity, booked count, waitlist length | _not yet discovered_ |
| Does a not-yet-open class appear in the listing at all? | _not yet discovered_ |
| Is there a field stating when booking opens? | _not yet discovered_ |

**The one to check first:** whether the API itself tells you the release time. If
it does, use it — it beats computing the release from a booking-window constant,
because it survives Elixia changing their policy or applying a different window
to a specific class. `src/schedule.ts` then becomes the fallback for classes not
yet listed, rather than the primary source of truth.

**Also check:** whether the class id is stable. If the id for next Tuesday's
09:00 Bodypump is only minted when the class becomes visible, the app cannot
pre-resolve it and must fetch the listing in the same run, immediately before
booking — which adds a request to the critical path and matters more here than
it would elsewhere, because a serverless function is killed at its time limit.

```
Paste a redacted listing response (one class object is enough) here.
```

---

## 5. Booking

| Question | Finding |
| --- | --- |
| Endpoint (method + URL) | _not yet discovered_ |
| Payload shape | _not yet discovered_ |
| Success response | _not yet discovered_ |
| Response when booking has not opened yet | _not yet discovered_ |
| Response when the class is full | _not yet discovered_ |
| Response when already booked (is it idempotent?) | _not yet discovered_ |
| Cancellation endpoint | _not yet discovered_ |

**Capture the failure modes deliberately** — they matter more than the success
case. The retry loop has to distinguish "too early, try again" from "full, stop"
from "already booked, stop and report success". Without the real error shapes
that logic is guesswork, and a retry loop that cannot recognise a permanent
failure is exactly the unbounded hammering to avoid.

The cheapest way to capture the "not open yet" response: try booking a class
just outside the window and record what comes back.

---

## 6. Waitlist

| Question | Finding |
| --- | --- |
| Separate endpoint, or the same one with a flag? | _not yet discovered_ |
| Payload shape | _not yet discovered_ |
| Does booking auto-fall-back to waitlist when full? | _not yet discovered_ |
| Is promotion off the waitlist automatic? | _not yet discovered_ |

---

## 7. Anti-bot signals

| Signal | Finding |
| --- | --- |
| CSRF token — where obtained, how sent | _not yet discovered_ |
| CAPTCHA anywhere in login or booking | _not yet discovered_ |
| Device fingerprinting / JS challenge (Akamai, Cloudflare, DataDome, PerimeterX) | _not yet discovered_ |
| Rate limiting — status code, `Retry-After`, observed threshold | _not yet discovered_ |
| Custom headers that look like an app signature or nonce | _not yet discovered_ |
| Does the API reject a plain `curl` carrying a valid token? | _not yet discovered_ |
| TLS/JA3 fingerprinting suspected? | _not yet discovered_ |

**This section decides whether the project is viable at all**, so do not treat it
as a footnote. The app's entire premise is that booking is reachable by plain
`fetch()` from a server. Two findings would break that premise outright:

- **A JS challenge or fingerprint check on the booking call.** A serverless
  function cannot execute a browser challenge. There is no workaround inside
  the stated constraints.
- **TLS fingerprinting.** The runtime does not expose the TLS client hello, so
  a server that fingerprints it will see a non-browser client regardless of
  which headers you send.

**The decisive test, and the one to run before trusting any of this:** take a
token from the browser, and replay the booking request with `curl` from a plain
shell. If that succeeds, the premise holds and the rest is engineering. If it
fails while the browser succeeds with the same token, stop and tell me — the
architecture needs rethinking before anything else is worth building.

---

## 8. Open questions for the account owner

Fill in during discovery; these change the app's behaviour and I should not
assume answers to any of them:

- [ ] Which membership tier — i.e. is the window 7 days or 14?
- [ ] Is the release time exactly the class's start time-of-day, or a fixed
      clock time (e.g. always 00:00) N days before?
- [ ] Which centre(s), and do they share one schedule endpoint?
- [ ] Is there a penalty for no-shows or late cancellation? This decides whether
      the bot may book speculatively.
- [ ] Any cap on concurrent bookings per member?

---

## Change log

| Date | What changed | Who |
| --- | --- | --- |
| 2026-08-13 | Template created. No discovery run — see [Why it is blank](#why-it-is-blank). | Claude |
| 2026-08-13 | App built against this template; all guesses isolated in `lib/elixia.ts` behind the `API_DISCOVERED` guard. | Claude |
| 2026-08-13 | Rebuilt as a hosted multi-user app; mock backend added so the app is usable before discovery. | Claude |
| 2026-08-13 | Ported to Next.js on Vercel with Upstash Redis. Adapter unchanged — the blanks below are still the only thing missing. | Claude |
| 2026-08-16 | Moved to Supabase (Postgres + Auth) and GitHub Actions cron. Adapter still unchanged. | Claude |
