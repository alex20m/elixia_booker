/**
 * Scheduling the booking tick through QStash.
 *
 * The booking watcher (.github/workflows/watch.yml) exists because GitHub's own
 * cron is not punctual enough to be trusted with a release instant. But its
 * *start* still depends on that same scheduler, and GitHub documents a
 * sufficiently loaded schedule trigger as dropped outright rather than merely
 * delayed — which is what happened on 2026-08-28, leaving no watcher awake for
 * nine hours and missing a booking with nothing in the Actions log to show for
 * it: no failed run, no queued run, just an absent one.
 *
 * QStash removes the scheduler from that path entirely. Instead of a job that
 * must already be running in order to notice a release, each release instant is
 * handed to a service whose whole product is delivering an HTTP call at a
 * chosen time, with retries and a dead-letter queue behind it.
 *
 * Two properties of the existing design are what make this simple:
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
 * loop after it. Mirrors the lead the watcher workflow uses for the same
 * reason.
 */
export const TICK_LEAD_MS = 20_000;

/** Where a scheduled tick should be delivered, once it is known to be reachable. */
export interface QstashTarget {
  appUrl: string;
  cronSecret: string;
}

/**
 * Whether this deployment can schedule through QStash at all.
 *
 * All three parts are required together. Being *partly* configured is the
 * genuinely dangerous state: a message published without the cron secret is
 * delivered and 401s until it exhausts its retries, and one with no origin
 * cannot be addressed at all. Both fail silently at delivery time — hours
 * after publishing, on a path nobody is watching — so the refusal happens here
 * instead, where the fallback is simply the existing watcher.
 */
export function qstashTargetFor(config: {
  qstashToken?: string | undefined;
  appUrl?: string | undefined;
  cronSecret?: string | undefined;
}): QstashTarget | null {
  const { qstashToken, appUrl, cronSecret } = config;
  if (!qstashToken || !appUrl || !cronSecret) return null;
  return { appUrl, cronSecret };
}

/** One scheduled invocation of /api/cron/tick. */
export interface TickMessage {
  url: string;
  headers: Record<string, string>;
  /**
   * Unix timestamp in **seconds** — QStash's unit, not the milliseconds this
   * codebase carries everywhere else.
   */
  notBefore: number;
  deduplicationId: string;
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
  cronSecret: string;
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
  { nowMs, appUrl, cronSecret }: TickScheduleOptions,
): TickMessage[] {
  const bySecond = new Map<number, TickMessage>();

  for (const release of releaseEpochMs) {
    const wakeMs = release - TICK_LEAD_MS;
    // A release already inside its wake window belongs to whatever is running
    // now. Scheduling it would ask QStash for a moment in the past, which it
    // delivers immediately — duplicating the current invocation's own work.
    if (wakeMs <= nowMs) continue;

    // Seconds, not milliseconds. Publishing ms here would push every booking
    // tens of thousands of years out, and nothing downstream would notice.
    const notBefore = Math.floor(wakeMs / 1000);
    if (bySecond.has(notBefore)) continue;

    bySecond.set(notBefore, {
      url: `${appUrl.replace(/\/+$/, '')}/api/cron/tick`,
      // The endpoint is Bearer-guarded; a message without this is delivered,
      // 401s, and retries its way into the dead-letter queue.
      headers: { Authorization: `Bearer ${cronSecret}` },
      notBefore,
      // Keyed by the wake second alone, so the id is identical no matter which
      // profile's reindex produced it or how many times it is republished.
      deduplicationId: `booking-tick-${notBefore}`,
    });
  }

  return [...bySecond.values()].sort((a, b) => a.notBefore - b.notBefore);
}

/**
 * Publish the ticks for a set of release instants.
 *
 * Never throws. Scheduling happens *after* the due rows are written, and those
 * rows are what the existing watcher books from, so a QStash outage must
 * degrade to "the old mechanism is still driving this" rather than failing the
 * settings save that triggered the reindex.
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
