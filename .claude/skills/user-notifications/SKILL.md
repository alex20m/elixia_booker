---
name: user-notifications
description: >-
  Send an app's alerts to the person who needs them, without making setup the
  user's problem. Use when adding notifications to an app, choosing between
  email and a chat platform, letting users pick a channel, connecting a
  Telegram/Slack/Discord chat to an account, or handling a public webhook that
  binds an external identity to a local one. Covers why a chat bot cannot reach
  a user who has not spoken to it first, the one-tap connect flow that replaces
  copying IDs by hand, what has to guard the webhook that finishes it, and the
  three obligations any send inside a time-critical loop has.
---

# Notifying users without making them do setup

Two questions decide most of this, and they are usually answered in the wrong
order. Teams pick the channel first (a chat bot: it buzzes, it feels modern) and
discover afterwards that every user has to complete a manual ritual before it
works. Pick by *what the app already knows about the user* instead.

## The address you already have beats the one you must collect

If the app has authentication, it already holds a verified email address. That
makes email the only channel with **zero** setup: a user is reachable from their
first request, before they have opened a settings page. Every other channel
starts at "the user must do something first".

This matters most for the alert nobody can afford to miss — the one saying the
automation has *stopped*. A user who never finished configuring notifications is
exactly the user who will not find out.

So: **default to email, offer the chat platform as an opt-in upgrade.** Not the
other way round, and not chat-only. The upgrade is worth offering — email
arrives when it arrives, a chat message buzzes now — but it is an upgrade.

Also offer an explicit **off**. Otherwise someone who does not want alerts
half-configures a channel and you cannot tell that state from a broken one.

## A chat bot cannot message a user first

This is a platform rule, not a limitation to engineer around: Telegram, and
messaging platforms generally, only let a bot send to a conversation that
already exists, and the conversation only exists once the user has started it.
The bot learns the chat's id from that first message and no other way.

That has a consequence people repeatedly design around and then rediscover:
**an OAuth-style login widget does not avoid the tap.** It hands you the user's
platform id, and sending to that id still fails until they have started the bot.
One deliberate action by the user is the floor. Aim to make it *one*.

### What the naive flow costs

The obvious flow is: user messages the bot, then reads their chat id out of the
platform's "recent updates" endpoint and pastes it into your settings page. It
works for exactly one user — you — and then fails, because:

- that endpoint's URL usually contains the **bot token**, which is the
  operator's secret, so the step cannot be delegated without handing it over;
- the id is unverified: whoever types it claims that chat, including someone
  else's;
- it asks a user to read raw JSON.

### The one-tap flow

Replace it with a deep link carrying a one-use token:

1. **Mint a token** server-side for the signed-in user: 32 bytes of randomness,
   hex. Store only a **hash** of it — for the minutes it lives it is a bearer
   credential, and a dump of that table must not be replayable.
2. **Show a link** that carries the token as the platform's start payload, and
   open it in a new tab. Give it a short TTL (ten minutes is plenty) and keep
   **one outstanding token per user** — replace the previous one when a new
   attempt starts, or every abandoned attempt leaves a working credential
   behind and the advertised window stops meaning anything.
3. **The user taps Start.** The platform delivers `/start <token>` to your
   webhook.
4. **Bind on the token, never on the sender.** Look up the hash, and if a live
   row exists, attach the chat id from that update to the user it names.
5. **Reply in the chat** so the user sees it worked, and refresh the page.

Deleting the row *is* what makes the token single-use, so do the read and the
delete in one statement (`DELETE ... RETURNING`), not a check followed by a
write: two requests arriving together must not both succeed, and on a public
endpoint a duplicate is one network hiccup away.

Connecting should also *select* the channel. Tapping Connect is the choice;
making the user return to a settings page and pick it again leaves the common
case one silent step short of working.

## The webhook is the most exposed thing you have

It answers callers with no session, because the platform has none. Everything
protecting it is what you put there:

- **A shared secret, checked first.** Registering the webhook lets you set a
  secret the platform then echoes on every call (Telegram sends
  `X-Telegram-Bot-Api-Secret-Token`). Compare it in constant time, before
  reading the body — an unauthorised caller should cost nothing and learn
  nothing. Put it in a header, not the URL path, where it would land in access
  logs.
- **Refuse everything when it is unconfigured.** A deployment that never set a
  secret must reject all callers rather than fall open — open-by-default here
  means anyone can bind their chat to whichever account is mid-connect.
- **Never trust identity fields in the update.** `message.from` is
  attacker-controlled. The token is the only thing that names an account. Take
  the chat id from the conversation the message arrived in, not the sender —
  they coincide in a private chat, so a mix-up passes every manual test.
- **Answer everything else 200.** Platforms retry 5xx. A body that is not JSON,
  chatter, an update type you do not handle: drop it and return success, or one
  malformed request becomes an indefinite retry loop against your database.
  Parse the body as *text* and guard `JSON.parse` — letting it throw inside the
  handler is how that loop starts.
- **Bound the body.** Reject anything far larger than a real update before
  parsing it.
- **Reply identically to every failure.** Unknown token, spent token, expired
  token, malformed token: one answer. Distinguishing them tells someone probing
  the endpoint which guesses were once real.

### Ordering that bites

The webhook is registered with the platform *by URL*, so it can only be
registered after the app is deployed at that URL, and re-registered whenever the
secret changes. Rotating means: set the variable → redeploy → re-run the
registration. In any other order, updates bounce in the gap. Registration is a
one-off command, not something the app does at boot — and there is usually a
companion endpoint (`getWebhookInfo`) that reports the last delivery error,
which is the first place to look when nothing arrives.

## Three obligations for a send inside a working loop

If notifications go out from the same code path that does the real work — a
booking, a deploy, a scheduled job — the send has obligations the rest of the
app does not:

- **Never throw.** The work already happened. A notifier that fails must return
  a status, not turn a success into an exception. This is easy to agree with and
  easy to lose the moment someone adds a second channel.
- **Never hang.** A request that is accepted and then never answered is worse
  than one that fails: it holds the loop, and everyone queued behind it pays.
  Bound it with a race against a timer, not only an `AbortSignal` — a signal
  binds the request only if whatever implements `fetch` honours it, while the
  race binds *you* regardless. Pass the signal too, so a bounded request is
  cancelled rather than merely abandoned.
- **Never leak the key.** The reason a failure reports usually gets logged, and
  some HTTP client failures quote the whole request back, headers included.
  Scrub known secrets out of anything reported. Bot tokens are especially
  exposed because they sit in the URL path.

**And log the failures.** Discarding the result is the default mistake: a
revoked token, a blocked bot or an unverified sender domain then stops every
alert permanently and silently — including the alert about things stopping. The
send stays best-effort; the *reason* has to survive.

## Where the failure modes actually live

The email path's real cost is not code, it is **domain verification**: a
transactional provider's test sender only reaches your own account address, so
without SPF/DKIM records for a real domain, every other user's mail silently
fails. Budget for it, and say so in setup docs, or the first external user is
the one who discovers it.

## Things worth pinning with tests

Most of the above fails invisibly, which makes it exactly what a test suite
should hold:

- a forged webhook call with no secret, or a wrong one, changes nothing;
- a replayed update binds nothing the second time;
- an expired token is refused;
- junk and chatter get 200, not 500;
- a send that never answers returns rather than hanging (a fake `fetch` that
  only settles on abort will hang the test if the deadline is missing — which
  is the correct failure);
- a reported failure reason does not contain the API key;
- the settings form does not post a blank chat id, which would silently
  disconnect on every save;
- an omitted field in a settings payload means "not part of this form", not
  "reset it" — otherwise saving a timezone moves someone off their channel.
