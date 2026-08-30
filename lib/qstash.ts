/**
 * Scheduling the booking tick through QStash.
 *
 * Booking used to be driven by a long-lived GitHub Actions job that slept to
 * the release on the runner's own clock. That job existed because GitHub's own
 * cron is not punctual enough to be trusted with a release instant — but its
 * *start* still depended on that same scheduler, and GitHub documents a
 * sufficiently loaded schedule trigger as dropped outright rather than merely
 * delayed. That happened on 2026-08-28, leaving no job awake for nine hours and
 * missing a booking with nothing in the Actions log to show for it: no failed
 * run, no queued run, just an absent one.
 *
 * QStash removes the scheduler from that path entirely. Instead of a job that
 * must already be running in order to notice a release, each release instant is
 * handed to a service whose whole product is delivering an HTTP call at a
 * chosen time, with retries and a dead-letter queue behind it.
 *
 * Two properties of the design are what make this simple:
 *
 *  - **The tick claims a window, not a booking.** `runDueBookings` claims
 *    everything due within a minute either side (lib/service.ts), so one
 *    invocation serves every user due at that instant. Messages are therefore
 *    deduplicated by *instant*, not by user or subscription.
 *  - **The tick is idempotent.** `claimDue` hands out each release once,
 *    atomically, so a duplicate delivery is a no-op. QStash guarantees
 *    at-least-once delivery, which would otherwise be a hazard; here it costs
 *    nothing.
 *
 * Together those let this module be re-run freely: every reindex republishes
 * every upcoming instant, and QStash's own deduplication makes the repeats free.
 * Nothing has to track message ids, and nothing has to be cancelled when a
 * subscription changes — a message whose bookings have since been unsubscribed
 * simply finds nothing due and returns.
 */

/**
 * How early to wake the tick before the release instant.
 *
 * Not the same thing as `DEFAULT_TIMINGS.leadMs`, which is how far before the
 * release the *booking request* fires. This is the handler's preparation
 * budget: enough to refresh a session and resolve the class id before
 * lib/booking.ts performs its own millisecond-precise sleep to T-0, while
 * leaving most of the invocation's time budget for that sleep and the retry
 * loop after it.
 */
export const TICK_LEAD_MS = 20_000;

/**
 * Vercel's ceiling for /api/cron/tick, in seconds.
 *
 * Exported here rather than only in the route so the two cannot drift: the
 * whole timing budget below is checked against this number, and a route that
 * quietly lowered its own `maxDuration` would invalidate that check without
 * failing anything.
 */
export const TICK_MAX_DURATION_SECONDS = 60;

/**
 * How long QStash is told to wait for the tick to answer, in seconds.
 *
 * Left unset, QStash uses "the maximum your plan allows" — a number nobody
 * here chose, that differs per plan and can change under you. The tick
 * deliberately holds its connection open (it wakes at T-minus-lead, sleeps to
 * the exact release millisecond, then retries), so the duration it may hold is
 * a property worth stating outright rather than inheriting.
 *
 * Sized to Vercel's ceiling, because that is the limit that actually bites
 * first: the platform kills the invocation at `TICK_MAX_DURATION_SECONDS`
 * whatever QStash is willing to wait for.
 */
export const TICK_TIMEOUT_SECONDS = TICK_MAX_DURATION_SECONDS;

/**
 * The furthest ahead QStash will accept a delivery, in ms.
 *
 * Not a guess: publishing a probe batch beyond it answers
 * `{"error":"quota maxDelay exceeded, current limit: 604800"}`, and 604800s is
 * seven days — the Free plan's ceiling, verified against the live account on
 * 2026-08-29. Paid plans allow more, so this is deliberately the *smallest*
 * documented ceiling rather than the one this account happens to have.
 */
export const QSTASH_MAX_DELAY_MS = 604_800_000;

/**
 * Headroom kept under that ceiling.
 *
 * `notBefore` is fixed when the batch is built, but QStash measures the delay
 * when it *receives* the request. A message computed at exactly the limit
 * arrives a moment past it — and because QStash validates the whole batch
 * before accepting any of it, that lands as a rejection of every message in
 * the request, not just the late one.
 */
export const PUBLISH_MARGIN_MS = 300_000;

/** The furthest ahead this module will schedule anything. */
export const MAX_TICK_DELAY_MS = QSTASH_MAX_DELAY_MS - PUBLISH_MARGIN_MS;

/** Where a scheduled tick should be delivered, once it is known to be reachable. */
export interface QstashTarget {
  appUrl: string;
}

/**
 * Whether this deployment can publish a scheduled tick through QStash at all.
 *
 * Both parts are required together. Being *partly* configured is the genuinely
 * dangerous state: a message pointed at no origin cannot be addressed at all,
 * and it fails silently at delivery time — hours after publishing, on a path
 * nobody is watching — so the refusal happens here instead. Whether an inbound
 * delivery can then be *authenticated* is a separate check on the signing keys
 * (`qstashSigningKeysFor`); `qstashConfigured` in lib/appConfig.ts is what ties
 * the two together for the health endpoint.
 */
export function qstashTargetFor(config: {
  qstashToken?: string | undefined;
  appUrl?: string | undefined;
}): QstashTarget | null {
  const { qstashToken, appUrl } = config;
  if (!qstashToken || !appUrl) return null;
  return { appUrl };
}

/**
 * One scheduled invocation of /api/cron/tick.
 *
 * Deliberately carries no Authorization header. QStash's own dashboard and
 * events API display a published message's headers in the clear to anyone
 * with account access, so a forwarded secret sits there in plaintext for as
 * long as the account's log retention keeps it — a second, wider copy of a
 * credential that used to live only in the deployment's own environment. The
 * endpoint verifies the message came from QStash by its signature instead
 * (lib/http.ts assertCronAuthorised), which needs nothing in the message to
 * leak.
 */
export interface TickMessage {
  url: string;
  /**
   * Unix timestamp in **seconds** — QStash's unit, not the milliseconds this
   * codebase carries everywhere else.
   */
  notBefore: number;
  deduplicationId: string;
  /**
   * Seconds QStash will wait for a response before giving up. Always set —
   * see TICK_TIMEOUT_SECONDS for why inheriting the plan default is not good
   * enough.
   */
  timeout: number;
}

/** The slice of `@upstash/qstash`'s Client this module needs. */
export interface TickPublisher {
  batchJSON(messages: TickMessage[]): Promise<unknown>;
}

/**
 * The real publisher, backed by `@upstash/qstash`.
 *
 * The SDK is imported lazily so a deployment without a token never loads it at
 * all — this path is dormant on every deployment until QStash is provisioned,
 * and a dormant path should cost nothing.
 */
export function createTickPublisher(token: string): TickPublisher {
  return {
    async batchJSON(messages: TickMessage[]): Promise<unknown> {
      const { Client } = await import('@upstash/qstash');
      return new Client({ token }).batchJSON(messages);
    },
  };
}

export interface TickScheduleOptions {
  nowMs: number;
  appUrl: string;
}

export interface ScheduleOutcome {
  scheduled: number;
  dormant: boolean;
  error?: string;
}

/**
 * Turn release instants into the messages that should exist for them.
 *
 * Pure, so the arithmetic that decides *when* a booking is attempted can be
 * tested without a network or a clock.
 */
export function tickMessagesFor(
  releaseEpochMs: readonly number[],
  { nowMs, appUrl }: TickScheduleOptions,
): TickMessage[] {
  const bySecond = new Map<number, TickMessage>();

  for (const release of releaseEpochMs) {
    const wakeMs = release - TICK_LEAD_MS;
    // A release already inside its wake window belongs to whatever is running
    // now. Scheduling it would ask QStash for a moment in the past, which it
    // delivers immediately — duplicating the current invocation's own work.
    if (wakeMs <= nowMs) continue;

    // Too far out for QStash to accept. Dropping it here rather than letting
    // QStash refuse it is the whole point: the refusal is not per-message, it
    // rejects the entire batch, so one instant ten days away silently took
    // tomorrow's booking down with it. The reindex horizon is deliberately
    // longer than this window, and the nightly run republishes, so an instant
    // skipped today is picked up on a later night with days to spare.
    if (wakeMs - nowMs > MAX_TICK_DELAY_MS) continue;

    // Seconds, not milliseconds. Publishing ms here would push every booking
    // tens of thousands of years out, and nothing downstream would notice.
    const notBefore = Math.floor(wakeMs / 1000);
    if (bySecond.has(notBefore)) continue;

    bySecond.set(notBefore, {
      url: `${appUrl.replace(/\/+$/, '')}/api/cron/tick`,
      notBefore,
      // Keyed by the wake second alone, so the id is identical no matter which
      // profile's reindex produced it or how many times it is republished.
      deduplicationId: `booking-tick-${notBefore}`,
      timeout: TICK_TIMEOUT_SECONDS,
    });
  }

  return [...bySecond.values()].sort((a, b) => a.notBefore - b.notBefore);
}

/**
 * Publish the ticks for a set of release instants.
 *
 * Never throws. Scheduling happens *after* the due rows are written, and those
 * rows are the source of truth the tick books from, so a QStash outage must
 * degrade to "nothing new was enqueued this run, the next reindex will retry"
 * rather than failing the settings save that triggered the reindex.
 */
export async function scheduleBookingTicks(
  releaseEpochMs: readonly number[],
  options: TickScheduleOptions & { publisher: TickPublisher | null },
): Promise<ScheduleOutcome> {
  const { publisher, ...scheduleOptions } = options;
  if (!publisher) return { scheduled: 0, dormant: true };

  const messages = tickMessagesFor(releaseEpochMs, scheduleOptions);
  if (messages.length === 0) return { scheduled: 0, dormant: false };

  try {
    await publisher.batchJSON(messages);
    return { scheduled: messages.length, dormant: false };
  } catch (err) {
    return { scheduled: 0, dormant: false, error: (err as Error).message };
  }
}

// --- verifying an inbound request actually came from QStash ----------------

/** The two signing keys QStash's Receiver needs to check a request. */
export interface QstashSigningKeys {
  currentSigningKey: string;
  nextSigningKey: string;
}

/**
 * Whether this deployment can verify a QStash signature at all.
 *
 * Both keys are required together, the same reasoning as `qstashTargetFor`:
 * `Receiver` needs the next key to keep verifying through a key rotation, so
 * a deployment carrying only the current one would start rejecting every
 * delivery the moment the account rotates, silently, on a path nobody is
 * watching until then.
 */
export function qstashSigningKeysFor(config: {
  currentSigningKey?: string | undefined;
  nextSigningKey?: string | undefined;
}): QstashSigningKeys | null {
  const { currentSigningKey, nextSigningKey } = config;
  if (!currentSigningKey || !nextSigningKey) return null;
  return { currentSigningKey, nextSigningKey };
}

/** The slice of `@upstash/qstash`'s Receiver that checking a request needs. */
export interface SignatureVerifier {
  verify(args: { signature: string; body: string }): Promise<boolean>;
}

/**
 * The real verifier, backed by `@upstash/qstash`'s Receiver.
 *
 * Lazily imported for the same reason `createTickPublisher` is: a deployment
 * without signing keys never loads the SDK for this path at all.
 *
 * `Receiver.verify` is documented to resolve `true` or throw `SignatureError`
 * on a bad signature, never to resolve `false` — caught here so a forged or
 * malformed signature reads as "not verified" to the caller rather than as an
 * unhandled rejection surfacing a 500 to whoever is attacking the endpoint.
 */
export function createSignatureVerifier(keys: QstashSigningKeys): SignatureVerifier {
  return {
    async verify({ signature, body }): Promise<boolean> {
      const { Receiver } = await import('@upstash/qstash');
      const receiver = new Receiver(keys);
      try {
        return await receiver.verify({ signature, body });
      } catch {
        return false;
      }
    },
  };
}
