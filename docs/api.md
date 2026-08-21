# Elixia API — discovery notes

> ## ✅ STATUS: DISCOVERED — the adapter runs against the real API
>
> Two local discovery runs (2026-08-20 and 2026-08-21) captured login, the
> schedule listing, successful bookings, a waiting-list placement and a real
> booking failure. §1–§7 below are findings from those captures, and
> `lib/elixia.ts` implements them: `API_DISCOVERED` is `true`.
>
> What is still unverified is called out inline and listed in
> [§8](#8-open-questions-for-the-account-owner). The three that matter most:
> **2FA was never triggered** so that path is untested; **rate limiting was
> never approached**, so its threshold and shape are unknown; and the booking
> call has still **never been replayed from outside a browser** (§7) — which
> the first real cron run will settle one way or the other.

## What depends on this file

Everything Elixia-facing lives in one file, `lib/elixia.ts`. This document is
where its shapes come from, so a change here and a change there go together.

Three findings shaped the code more than the rest, and each one *removed*
something that used to exist:

1. **Auth is cookies, not tokens** (§1–§3). There is no bearer token and no
   refresh endpoint, so the token-parsing and refresh code is gone; a lapsed
   session is recovered by logging in again with the stored password.
2. **Booking never reports "full"** (§5, §6). A full class is placed on the
   waiting list by the same call, so the `full` outcome, the `onFull`
   preference and the second waitlist request are all gone. The app books what
   it can get.
3. **A class is invisible before its window opens** (§4). "Too early" is
   therefore *resolution failing*, not a booking error — so resolving the class
   id is retried at T-0 rather than being a precondition of the run.

A mock backend (`lib/mock.ts`, `MOCK_ELIXIA=1`) still stands in for local work
and tests, and now mirrors the real behaviour above.

### Still open, and worth knowing before relying on this

**Does Elixia rate-limit per account or per source IP?** Every user's booking
leaves from a Vercel function, and those share a small pool of egress
addresses — so a per-IP limit would be shared across all users and would need
global pacing rather than the per-user budget that exists today. Nothing in
either capture came close to a limit, so this is untested (§7).

**Is 2FA ever demanded?** It was not in either run. If it can be triggered, the
unattended re-login path in §3 breaks and linking would have to be redone by
hand each time a session expires.

---

## How discovery was run

Discovery cannot be attempted from the Claude Code cloud container — no network
route to Elixia (the egress proxy denies the host), no credentials, and no
display for the headed first run that 2FA would need. **Discovery is a local
task by nature**, and was run by the account owner on their own machine.

Two runs were needed:

* **2026-08-20** — captured login, schedule-page navigation and two live
  bookings (one landing on a waiting list). This settled §1, §2, §5 and §6.
* **2026-08-21** — re-run after fixing a capture bug (below). This settled §4,
  and happened to catch a real booking failure (a 409) that the first run had
  not, which is what made the error taxonomy in §5 real rather than guessed.

**The capture bug is worth knowing about**, because it hid the most important
finding and did so silently. The capture harness capped every recorded response
body at 200,000 bytes, and `/varaukset` is ~1.2–1.8MB. The cap cut each schedule
response off *inside the page's header markup*, well before the embedded class
data — so the first capture looked complete (7 successful `/varaukset`
responses, HTTP 200 each) while containing none of the answers. Raising the cap
was all it took. The lesson outlives the harness: **a capture that yields an
endpoint but none of its data is truncated, not empty.**

---

## If the shapes drift

The adapter parses a page Elixia can restyle at will, so assume this will
eventually break. It breaks *loudly* — `extractDataProps` throws rather than
returning something empty, and `findClassId` says which of "date outside the
window", "date missing" and "class missing" it hit — so the failure names its
own cause.

The Playwright capture harness that produced these findings has been removed:
its job was discovering an unknown API, and re-checking a *known* one needs
nothing more than a browser's devtools.

1. Sign in at `https://www.elixia.fi/varaukset`, pick a club, and view source.
2. Find `<script data-props="true" type="application/json">` and compare its
   `schedule.events[].metadata` shape against §4.
3. For a booking failure, book something in the Network tab and read the
   status code — not the message text, which is localized (§5).

**One trap, since it cost a whole capture run:** the schedule page is ~1.5MB,
and anything that truncates a response body will cut it off inside the header
markup, well before the class data. A capture that shows the endpoint but none
of its data is truncated, not empty.

---

## 1. Login

| Question | Finding |
| --- | --- |
| Login endpoint (method + URL) | Not a single endpoint — a redirect chain. `GET /kirjaudu-sisaan?onSuccess=...` → `GET /api/sats-group-auth-log-in?redirect=...` → `GET auth.satsgroup.com/realms/sats/protocol/openid-connect/auth?...` (renders the form) → `POST auth.satsgroup.com/realms/sats/login-actions/authenticate?session_code=...&execution=...` (submits it) → `GET /api/sats-group-auth-log-in-return?...code=...` → lands signed in. |
| Is it Elixia's own domain or a SATS Group / third-party IdP? | Third-party: a Keycloak realm at `auth.satsgroup.com` (`realms/sats`), shared across the SATS Group. `www.elixia.fi` is the OAuth2 client (`client_id=sats-web`), not the IdP. |
| Request content type | The credentials POST is a plain HTML form: `application/x-www-form-urlencoded`. Everything else in the chain is a GET. |
| Request payload shape | `username=<email>&password=<password>&credentialId=` (the third field was empty in the capture — likely selects a credential type when more than one exists, e.g. WebAuthn). |
| Response status + payload shape | Success: 302 redirects, no JSON body anywhere. Wrong credentials: Keycloak re-renders the **same** login form at **HTTP 200** — not an error status — so "did the session cookie show up" is the only reliable success signal, not the status code of any one hop. |
| Access token returned? Format (JWT / opaque)? | None. No bearer token exists anywhere in this flow. |
| Refresh token returned? | None. |
| Token lifetime (`exp` claim, `expires_in`, cookie `Max-Age`) | The session cookie's `Max-Age` is `1209600` seconds — 14 days. |
| Session cookies set (names, `HttpOnly`, `Secure`, `SameSite`, domain) | `www.elixia.fi` sets `.SATS_GROUP_AUTH` plus three numbered continuations, `.SATS_GROUP_AUTH_00`/`_01`/`_02` — the session is too large for one cookie. All four: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=1209600`. (Transient cookies on `auth.satsgroup.com` — `AUTH_SESSION_ID`, `KC_AUTH_SESSION_HASH`, `KC_RESTART`, `KEYCLOAK_IDENTITY`, `KEYCLOAK_SESSION` — only matter mid-flow and are not stored.) |
| Any pre-login handshake (nonce, PKCE, `state`, CSRF seed)? | No PKCE on this client (`code_challenge` is absent from the `sats-web` authorize URL — a *second* client used by `oma.elixia.fi` in the same session did use PKCE, so it is client-specific, not realm-wide). `state` here is literally the post-login path (`/omat-sivut`), not a random value. The only thing standing in for CSRF protection is that the login form's POST target embeds a server-issued `session_code` + `execution` pair — there is no separate hidden CSRF field to extract. |
| 2FA/MFA challenge — always, or only on new devices? | Not observed — the captured run went straight from the login form to a redirect. One data point only; this session's device/cookie history may already have been trusted. Unconfirmed either way. |

**Why it matters:** the app exchanges a password for tokens once, at sign-in,
and never stores the password. Login turned out to be a full OAuth2
authorization-code redirect chain rather than a JSON POST — but every hop is
plain HTTP (no JavaScript runs anywhere in it), so it still replays
server-side with nothing more than a cookie jar and a small HTML scrape for
the form's `action` URL. `lib/elixia.ts`'s `performElixiaLogin` implements
exactly this chain. See §7 for what was and was not checked for anti-automation
defenses along the way.

```
GET  https://www.elixia.fi/kirjaudu-sisaan?onSuccess=%2Fomat-sivut                        -> 302
GET  https://www.elixia.fi/api/sats-group-auth-log-in?redirect=%2Fomat-sivut              -> 303
GET  https://auth.satsgroup.com/realms/sats/protocol/openid-connect/auth?...              -> 200 (login form)
POST https://auth.satsgroup.com/realms/sats/login-actions/authenticate?session_code=...&execution=...
     content-type: application/x-www-form-urlencoded
     body: username=<REDACTED_EMAIL>&password=<REDACTED>&credentialId=
                                                                                            -> 302
GET  https://www.elixia.fi/api/sats-group-auth-log-in-return?state=...&code=...            -> 302
     set-cookie: .SATS_GROUP_AUTH=<REDACTED>; Max-Age=1209600; Path=/; Secure; HttpOnly; SameSite=Lax
     (+ .SATS_GROUP_AUTH_00 / _01 / _02, same attributes)
GET  https://www.elixia.fi/omat-sivut                                                      -> 200 (signed in)
```

---

## 2. Carrying auth on subsequent requests

| Question | Finding |
| --- | --- |
| Bearer header, cookie, or both? | Cookie only. The `/api/book` request carries no `Authorization` header at all — just the four `.SATS_GROUP_AUTH*` cookies from §1. |
| Exact header name and value format | Standard `Cookie:` header, e.g. `Cookie: .SATS_GROUP_AUTH=...; .SATS_GROUP_AUTH_00=...; .SATS_GROUP_AUTH_01=...; .SATS_GROUP_AUTH_02=...`. |
| Any additional required headers (client id, app version, locale, device id)? | None of that kind seen. The captured booking request sent the usual browser fetch headers (`accept`, `content-type`, `origin`, `referer`, `sec-fetch-*`) but nothing resembling an API key, app-version header, or device id. |
| Do API calls fail without those extra headers, or are they cosmetic? | **Not yet discovered** — the minimal-header replay test below has not been run. `lib/elixia.ts` currently sends `cookie`, `accept`, `content-type`, `origin` and `referer` because they were cheap to include and match the browser, not because they are confirmed load-bearing. |

**Test to run:** replay one booking request with `curl`, carrying only the
cookie, then add headers back one at a time until it succeeds. The minimal
working set is what the app should send — nothing more, nothing less. Record
which headers are load-bearing, because guessing wastes a booking window. This
still has to be done by the account owner, live.

---

## 3. Token refresh

| Question | Finding |
| --- | --- |
| Refresh endpoint exists? | None observed. Nothing in the captured "refresh" phase (a plain page reload with the existing session cookies) hit any endpoint resembling a token exchange — because there is no token to exchange, only a cookie. |
| Method, URL, payload | None observed. |
| Triggered proactively on a timer, or reactively on a 401? | N/A — see above. |
| Does refresh rotate the refresh token? | N/A — no refresh token exists. |
| What does a refresh failure look like? | Not observed. Presumably: the 14-day session cookie simply expires, and the next authenticated request either 401s or itself redirects into the login chain from §1 — not yet confirmed. |

**Why it matters:** with no refresh endpoint, "keeping a session alive" can
only mean re-running the full login chain with the stored password, which is
exactly what the app already falls back to when it has no refresh token (see
`service.ts`'s `runDueBookings`). `ElixiaClient.refresh()` in `lib/elixia.ts`
reflects this: it throws rather than pretending a refresh call exists, and
because `login()` never sets `tokens.refreshToken`, the app's own fallback
logic never actually calls it.

---

## 4. Schedule listing

| Question | Finding |
| --- | --- |
| Endpoint (method + URL) | `GET https://www.elixia.fi/varaukset` — a server-rendered HTML page, not a JSON API. Every filter change is a full page navigation; no `xhr`/`fetch` to any listing endpoint exists (checked across both captures). **The data is still structured**: the page embeds its entire props object in one `<script data-props="true" type="application/json">` tag, and that object holds both the club list and the classes. Parsing that tag *is* the listing API. |
| Query parameters (centre, date range, activity type, paging) | `clubIds` (e.g. `741`), `club-search`, `class-search`, `groupExerciseTypeIds`, `groupExerciseTypeCluster` (e.g. `Cardio`, `Boxing`), `instructor-search`, `timeOfDay` (e.g. `5_EVENING`). **`clubIds` is mandatory**: requested without it the page renders an "apply filters" prompt and carries no `schedule.events` at all. No date-range or paging parameter exists — the response always spans the whole window. |
| How is a centre/club identified? | A numeric id. The full id→name mapping (226 clubs group-wide) is in the page's own filter options: `{queryName: "clubIds", options: [{value: "741", label: "Circus"}, …]}`. `lib/elixia.ts`'s `listClubOptions` reads exactly that — it is both the centre chooser's list and, via `findClubIdByName`, how a stored centre name resolves — so a user may store either the id or the club's name. |
| How is a single class instance identified? Stable across days? | `"<clubId>p<number>"`, e.g. `741p70111`. **Per-occurrence, not per-class**: the same weekly class has a different id on each date (`741p70111` on one day, `741p70095` on another). An id therefore only ever resolves for one concrete date, which is why `resolveClassId` takes a `classDate`. |
| Class start time format — local, UTC, or offset-bearing? | **Offset-bearing ISO 8601**: `metadata.startsAt` = `"2026-08-21T17:00:00+03:00"`. `metadata.time` carries the same instant as a display string, `"17:00"`. The offset being explicit removes any DST guesswork on the listing side. |
| Fields for capacity, booked count, waitlist length | `hasWaitingList` (bool), `waitingListCount` (int) and `isBooked` (bool) per class. There is **no capacity or booked-count field** — you cannot tell how full a class is before trying, only whether a waiting list exists and how long it is. |
| Does a not-yet-open class appear in the listing at all? | **No.** `schedule.dateList.dates` lists ~35 dates, each with `disabled: true|false`; every date past the booking window is `disabled: true` **and carries zero events**. A class further out than the window is not merely unbookable, it is invisible. |
| Is there a field stating when booking opens? | **None.** No per-class release time, and no window length either — the window is only implied by where `disabled` flips. |

**The same props are the class chooser.** `collectClassOptions` reads
`schedule.events` for one club and collapses it to the distinct
name/weekday/time slots — the listing spans ~14 days, so every weekly class
appears in it at least once. That is deliberately the *same* source
`findClassId` matches against at T-0: a class the parser cannot see is one this
app could never book, so refusing to subscribe to it at all is not a stricter
rule than booking's, it is the same rule applied earlier. Two limits follow
from the source rather than from the UI: a class Elixia has not published yet
cannot be offered, and a class dropped from the timetable disappears from the
chooser while any existing subscription to it keeps failing to resolve.

**The consequence that shaped `booking.ts`.** Because an unopened class is
absent rather than rejected, "too early" cannot come back from the booking
call — it shows up as *resolution failing*. So resolving the class id is no
longer a precondition done once before the sleep; it is attempted early as an
optimisation, and retried at T-0 if it was not yet resolvable. A failure to
resolve maps onto the retryable `too-early` outcome
(`ClassNotListedError` → `{kind: 'too-early'}`).

**The listing span is NOT your booking window.** In the 2026-08-21 capture,
dates `2026-08-21` through `2026-09-04` were enabled and `2026-09-05` onward
disabled — 14 days. It is tempting to read that as "this account can book 14
days ahead". **That reading is wrong**, and it was made here once already: the
account owner confirmed 7 days is the limit on a normal membership, with 14
reserved for Premium.

What the date list actually describes is how far ahead Elixia *publishes the
schedule*, which is the same for everyone. How far ahead *you* may book is a
property of your membership tier, and the listing does not carry it — a class
eight days out is visible, listed, and completely unbookable by a normal
member, with nothing in the response distinguishing it from one you can book.

So the booking window has to be configured, not detected. It is
`bookingWindowDays` on the profile (7 by default, 14 for Premium), and getting
it wrong is silent in both directions: too high and every release fires before
booking opens, burning the retry budget against a class that is not yet
bookable; too low and it fires days late, by which point a popular class is
gone or full.

**What is still unknown, and it matters for timing.** The window is *day*
granular in the listing — a whole date flips from disabled to enabled — but
nothing says at what clock time it flips. Two readings fit the single snapshot:
booking opens at midnight N days ahead, or it opens rolling per-class at the
class's own time-of-day. `lib/schedule.ts` assumes the latter. The two coincide
often enough that this has not been settled, and settling it needs two captures
taken across a release boundary rather than one snapshot. The retry-at-T-0
design above works under either reading, which is why this is a documented
unknown rather than a blocker.

**Not yet used: a lighter endpoint may exist.** Each day group carries
`loadMoreEndpoint: "/api/group-exercise-search-day"`, which is presumably a
JSON API for a single day and would be far cheaper than re-parsing a ~1.5MB
page. It was never called in either capture, so its request and response
shapes are unknown and the code does not use it. Capturing it is the obvious
next optimisation for the critical path.

```jsonc
// One day group, and one class object, from schedule.events (redacted):
{
  "date": "2026-08-21",
  "bookEndpoint": "/api/book",
  "unbookEndpoint": "/api/unbook",
  "loadMoreEndpoint": "/api/group-exercise-search-day",
  "totalHits": 2,
  "events": [
    {
      "id": "741p70111",
      "isBooked": false,
      "hasWaitingList": true,
      "waitingListCount": 12,
      "groupExerciseLink": { "href": "/kaikki-ryhmaliikuntatunnit/hiit-run-box", "text": "HIIT Run & Box" },
      "metadata": {
        "name": "HIIT Run & Box",
        "clubName": "Circus",
        "startsAt": "2026-08-21T18:30:00+03:00",
        "time": "18:30",
        "duration": 60,
        "durationText": "min",
        "instructor": "w/ <name>"
      }
    }
  ]
}
```

---

## 5. Booking

| Question | Finding |
| --- | --- |
| Endpoint (method + URL) | `POST https://www.elixia.fi/api/book`. |
| Payload shape | `{"id": "<classId>"}` — just the class id. Nothing else; **no waitlist flag**. |
| Success response | `200`, JSON: `{"dataLayer":[…analytics, ignore…], "payload":{"className","clubId","clubName","participationId","status","waitingListPosition","hasWaitingList"}}`. `status` is `"Booked"` or `"OnWaitingList"` — see §6. `participationId` (e.g. `"741p1295323"`) is the id to keep: cancellation needs it, not the class id. It is minted fresh per booking (booking, cancelling and rebooking the same class gave `741p1299243` then `741p1299244`). |
| **The error taxonomy** | Published by the site itself, in the schedule page's props under `schedule.event.errorMessages.book`: `badRequest`, `conflict`, `forbidden`, `unauthorized`, `unknown`, `unknownDownstream`. That enumerates every failure the endpoint produces. Note what is *absent*: no "class full", and no "too early". |
| Response when booking has not opened yet | **No such response exists.** The class is not on the schedule at all, so there is no id to post — see §4. |
| Response when the class is full | **Not an error.** `200` with `status: "OnWaitingList"` — see §6. |
| Response when already booked / overlapping | `409` with `{"message":"Sinulla on voimassa oleva varaus päällekkäin."}` ("you have an overlapping reservation"). Observed directly. **This covers both** booking the same class twice and holding a *different* class at the same time — the API does not distinguish them, so nor can the app. Permanent either way. |
| Cancellation endpoint | `POST https://www.elixia.fi/api/unbook`, body `{"participationId": "<participationId>"}`. Response `200`, body `{}`. Confirmed against both a `"Booked"` and an `"OnWaitingList"` participation. |

**Error bodies are localized.** Every message above came back in Finnish,
matching the account's `ui_locales=fi`. This is why `classifyBookingResponse`
keys on the **status code only** and never on message text — an earlier version
matched English substrings (`"already"`, `"full"`, `"not open"`) and would have
classified every real failure as an unrecognised error. The message is still
carried through into the outcome's `detail`, so the notification can quote what
Elixia actually said, but nothing branches on it.

| Status | Outcome | Retryable |
| --- | --- | --- |
| `200` + `status: "Booked"` | `booked` | — |
| `200` + `status: "OnWaitingList"` | `waitlisted` | — |
| `401` unauthorized | `unauthorized` (session lapsed) | no |
| `403` forbidden ("Varausten teko on estetty") | `unauthorized` (booking blocked — a membership problem, not an expired session) | no |
| `409` conflict | `already-booked` | no |
| `429` | `rate-limited` | yes |
| `404` | `too-early` | yes |
| `400`, `5xx` | `error` | yes |

---

## 6. Waitlist

| Question | Finding |
| --- | --- |
| Separate endpoint, or the same one with a flag? | **The same endpoint, no flag.** `POST /api/book` is called identically whether the class has room or not; the server decides. |
| Payload shape | Same as booking — see §5. |
| Does booking auto-fall-back to waitlist when full? | **Yes, silently.** A full class with `hasWaitingList: true` returns `200` with `status: "OnWaitingList"` and `waitingListPosition` (13 and 37 observed). There is no way to ask for a booking *without* accepting a waiting-list place, because the request carries no such choice. |
| Is promotion off the waitlist automatic? | _not yet discovered_ — no capture ran long enough to see a place open up. |

**This deleted a feature.** The app used to offer "join waitlist" vs "skip if
full" per class, first attempting a plain booking and then a second, explicit
waitlist request. Neither half of that is possible: there is no second call to
make, and "skip" cannot be honoured by asking differently — it could only be
done by letting the booking land and then immediately `/api/unbook`-ing it,
which is worse than useless for a bot meant to secure a place. The preference,
the `full` outcome and the follow-up request are all gone; the app books, and a
waiting-list place counts as success.

---

## 7. Anti-bot signals

| Signal | Finding |
| --- | --- |
| CSRF token — where obtained, how sent | None as a separate field. The closest equivalent is the `session_code`/`execution` pair Keycloak bakes into the login form's own POST URL (§1) — there is nothing comparable protecting `/api/book`, which is a plain cookie-authenticated POST. |
| CAPTCHA anywhere in login or booking | None observed. The Keycloak login page's HTML was checked directly for `captcha`/`turnstile`/`hcaptcha`/`recaptcha` markers — none present. Booking was not separately checked (no reason to expect one on an authenticated JSON POST, but that is an assumption). |
| Device fingerprinting / JS challenge (Akamai, Cloudflare, DataDome, PerimeterX) | None observed. The login page HTML was checked for `cloudflare`/`datadome`/`perimeterx`/`akamai`/`fingerprint`/`challenge` markers — none present. The entire login chain is server-rendered HTML and redirects; no JavaScript executes as part of it, which is itself evidence against a JS challenge being in the critical path. |
| Rate limiting — status code, `Retry-After`, observed threshold | _not yet discovered_ — both captures made a handful of requests over a few minutes, nowhere near any threshold. The retry loop handles a `429` with `Retry-After` if one appears, but that path has never been exercised against the real server. |
| Custom headers that look like an app signature or nonce | None seen on `/api/book` beyond ordinary browser fetch headers (see §2). |
| Does the API reject a plain `curl` carrying a valid token (here: cookie)? | **Not yet directly tested.** This is the decisive test described below and still has to be run live by the account owner. What the capture does show: `/api/book` is an ordinary same-origin `fetch()` call with no token/nonce/signature computed client-side — nothing in the request depends on JavaScript having run, which is suggestive but not the same as a confirmed `curl` replay. |
| TLS/JA3 fingerprinting suspected? | _not yet discovered_ — cannot be checked from a browser capture at all; only a live `curl` replay from a real deploy environment (e.g. a Vercel function) would show it. |

**This section decides whether the project is viable at all**, and it is the
one thing discovery could not settle. The app's entire premise is that booking
is reachable by plain `fetch()` from a server. Two findings would break that
premise outright:

- **A JS challenge or fingerprint check on the booking call.** A serverless
  function cannot execute a browser challenge. There is no workaround inside
  the stated constraints.
- **TLS fingerprinting.** The runtime does not expose the TLS client hello, so
  a server that fingerprints it will see a non-browser client regardless of
  which headers you send.

Everything observed points *away* from both: the whole login chain is
server-rendered HTML with no JavaScript in it, and `/api/book` is an ordinary
cookie-authenticated POST carrying nothing computed client-side. But a browser
capture cannot prove a negative here — it only shows that the browser was not
challenged.

**The decisive test is still outstanding:** replay the booking request from a
plain shell (or from the deployed Vercel function) carrying only the session
cookie. The first real cron run is that test, which is why the first run should
be watched rather than trusted. If it fails while the browser succeeds with the
same cookie, the architecture needs rethinking before anything else is worth
building.

---

## 8. Open questions for the account owner

- [x] **Which membership tier — is the window 7 days or 14?** **7** on a normal
      membership; 14 is Premium only, confirmed by the account owner. This was
      briefly recorded as 14 by misreading the schedule listing's 14-day span
      as a booking window — see §4 for why those are different things. The app
      defaults to 7, which is correct here.
- [ ] **Is the release time the class's own time-of-day, or a fixed clock time
      N days before?** Still unknown, and it decides whether releases fire at
      the right minute — see §4. Settling it needs two captures either side of
      a release boundary. Until then the retry-at-T-0 path absorbs the
      difference, at the cost of some wasted attempts.
- [x] **Which centre(s), and do they share one schedule endpoint?** One
      endpoint for all of them, selected by `clubIds`; 226 clubs are listed
      group-wide (§4).
- [ ] **Is there a penalty for no-shows or late cancellation?** Unanswered, and
      it matters more now than before: since a full class silently becomes a
      *waiting-list* place (§6), the bot can accumulate placements the user
      never consciously accepted. If late cancellation is penalised, that is a
      real cost.
- [ ] **Any cap on concurrent bookings per member?** Unanswered. The observed
      `409` is about *overlapping* bookings specifically, which is not the same
      thing as a total cap.

---

## Change log

| Date | What changed | Who |
| --- | --- | --- |
| 2026-08-13 | Template created. No discovery run. | Claude |
| 2026-08-13 | App built against this template; all guesses isolated in `lib/elixia.ts` behind the `API_DISCOVERED` guard. | Claude |
| 2026-08-13 | Rebuilt as a hosted multi-user app; mock backend added so the app is usable before discovery. | Claude |
| 2026-08-13 | Ported to Next.js on Vercel with Upstash Redis. Adapter unchanged — the blanks below are still the only thing missing. | Claude |
| 2026-08-16 | Moved to Supabase (Postgres + Auth) and GitHub Actions cron. Adapter still unchanged. | Claude |
| 2026-08-17 | Moved to Neon (Postgres + Neon Auth). Adapter still unchanged. | Claude |
| 2026-08-20 | Real discovery run (login, schedule navigation, two live bookings). §1, §2, §5, §6 filled in; `lib/elixia.ts` rewritten to match (real login flow, real `/api/book` shape). §4 (schedule listing) still blocked — the capture's body cap cut it off, so the re-run below was needed. | Claude |
| 2026-08-21 | Second capture with the raised cap. §4 settled: the listing is the page's embedded `data-props` JSON, `clubIds` is mandatory, class ids are per-occurrence, and an unopened class is absent rather than rejected. The run also caught a real `409`, which turned §5's error taxonomy from guesses into the site's own published `errorMessages` map — and showed error text is localized Finnish, so classification moved to status codes only. `resolveClassId` implemented; `API_DISCOVERED = true`. Waitlist branching removed throughout: booking is a single call whose waiting-list placement counts as success (§6). The capture harness and its output were then deleted — its job was discovering an unknown API, and this document is now the record. | Claude |
