import { describe, expect, it, vi } from 'vitest';
import {
  TICK_LEAD_MS,
  tickMessagesFor,
  scheduleBookingTicks,
  qstashTargetFor,
  type TickMessage,
} from '@/lib/qstash';

/**
 * QStash is the scheduling path that replaces depending on GitHub Actions' own
 * cron to be punctual (see .github/workflows/watch.yml for the failure that
 * motivated it: a schedule trigger dropped outright, silently, for hours).
 *
 * The tick endpoint claims a window and is idempotent, so the design leans on
 * that: every reindex re-publishes every upcoming instant, and QStash's own
 * deduplication makes the repeats free. That only holds if the deduplication id
 * is stable for a given instant, which is what most of these assert.
 */

const APP_URL = 'https://booker.example';
const SECRET = 'sekret';

function opts(nowMs: number) {
  return { nowMs, appUrl: APP_URL, cronSecret: SECRET };
}

/** Checked indexing, so a missing message fails as itself rather than as a TypeError. */
function nth(messages: readonly TickMessage[], index: number): TickMessage {
  const message = messages[index];
  if (!message) {
    throw new Error(`expected a message at ${index}, got ${messages.length} in total`);
  }
  return message;
}

describe('choosing which ticks to schedule', () => {
  it('wakes the tick before the release, not at it', () => {
    // The handler has to refresh a session and resolve the class id before its
    // own precise sleep to T-0 (lib/booking.ts). Firing it exactly at the
    // release instant would spend that preparation *after* booking opened,
    // which is the race this app exists to win.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const message = nth(tickMessagesFor([release], opts(release - 60 * 60_000)), 0);

    expect(message.notBefore).toBe((release - TICK_LEAD_MS) / 1000);
    expect(TICK_LEAD_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('sends notBefore in seconds, not the milliseconds used everywhere else', () => {
    // The whole app carries epoch *milliseconds*; QStash's notBefore is a unix
    // timestamp in *seconds*. Publishing ms here would schedule the booking
    // roughly fifty thousand years late, and nothing else in the system would
    // notice — the row would simply never fire.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const message = nth(tickMessagesFor([release], opts(release - 60_000)), 0);

    expect(message.notBefore).toBeLessThan(release / 100);
    expect(message.notBefore).toBe(Math.floor((release - TICK_LEAD_MS) / 1000));
  });

  it('collapses instants that share a wake second into one tick', () => {
    // One tick claims every booking due in its window, across all users, so a
    // second message for the same instant is pure waste. Two users booking the
    // same class release must not cost two invocations.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const messages = tickMessagesFor([release, release, release + 200], opts(release - 60_000));

    expect(messages).toHaveLength(1);
  });

  it('gives one instant the same deduplication id every time it is scheduled', () => {
    // Reindex runs on every settings change and nightly. Without a stable id
    // each run would enqueue a fresh copy of every upcoming release, and the
    // "just republish everything" design would multiply invocations instead of
    // being free.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const first = tickMessagesFor([release], opts(release - 60 * 60_000));
    const second = tickMessagesFor([release], opts(release - 30 * 60_000));

    expect(nth(first, 0).deduplicationId).toBe(nth(second, 0).deduplicationId);
    expect(nth(first, 0).deduplicationId).toBeTruthy();
  });

  it('gives different instants different deduplication ids', () => {
    // The mirror of the rule above: if two releases collided on one id, the
    // second would be accepted and silently never delivered.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const messages = tickMessagesFor([release, release + 3_600_000], opts(release - 60_000));

    expect(messages).toHaveLength(2);
    expect(nth(messages, 0).deduplicationId).not.toBe(nth(messages, 1).deduplicationId);
  });

  it('drops releases whose wake moment has already passed', () => {
    // A release already inside its wake window belongs to the tick running now,
    // not to a message scheduled for the past — QStash would deliver it
    // immediately, duplicating work the current invocation is already doing.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const nowMs = release - TICK_LEAD_MS + 1;

    expect(tickMessagesFor([release], opts(nowMs))).toEqual([]);
  });

  it('carries the cron secret so the tick endpoint authorises it', () => {
    // /api/cron/tick is Bearer-guarded (lib/http.ts assertCronAuthorised).
    // A message published without it is delivered, rejected 401, and retried
    // until it lands in the dead-letter queue — the booking silently missed.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const message = nth(tickMessagesFor([release], opts(release - 60_000)), 0);

    expect(message.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(message.url).toBe(`${APP_URL}/api/cron/tick`);
  });
});

describe('publishing the ticks', () => {
  const release = Date.parse('2026-09-01T10:00:00.000Z');
  const nowMs = release - 60 * 60_000;

  it('does nothing at all when QStash is not configured', async () => {
    // The GitHub Actions watcher is still the live mechanism. Until a token
    // exists this path must be inert rather than half-working.
    const publisher = { batchJSON: vi.fn() };
    const result = await scheduleBookingTicks([release], {
      ...opts(nowMs),
      publisher: null,
    });

    expect(result).toEqual({ scheduled: 0, dormant: true });
    expect(publisher.batchJSON).not.toHaveBeenCalled();
  });

  it('publishes every upcoming instant in a single request', async () => {
    // One HTTP call per release would make the nightly reindex across all
    // users a burst of hundreds of requests.
    const batchJSON = vi.fn().mockResolvedValue([]);
    const result = await scheduleBookingTicks([release, release + 3_600_000], {
      ...opts(nowMs),
      publisher: { batchJSON },
    });

    expect(batchJSON).toHaveBeenCalledTimes(1);
    expect(batchJSON.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result).toEqual({ scheduled: 2, dormant: false });
  });

  it('does not call out at all when nothing is upcoming', async () => {
    const batchJSON = vi.fn().mockResolvedValue([]);
    const result = await scheduleBookingTicks([release], {
      ...opts(release + 60_000),
      publisher: { batchJSON },
    });

    expect(batchJSON).not.toHaveBeenCalled();
    expect(result).toEqual({ scheduled: 0, dormant: false });
  });

  it('reports a publish failure instead of throwing it', async () => {
    // Scheduling runs after the due rows are already written, and those rows
    // are what the existing watcher books from. A QStash outage must not
    // propagate out of reindex and fail the settings save that triggered it —
    // that would turn a degraded scheduler into a broken app.
    const batchJSON = vi.fn().mockRejectedValue(new Error('qstash unreachable'));
    const result = await scheduleBookingTicks([release], {
      ...opts(nowMs),
      publisher: { batchJSON },
    });

    expect(result.scheduled).toBe(0);
    expect(result.error).toMatch(/qstash unreachable/);
  });
});

describe('deciding whether QStash is live for this deployment', () => {
  const complete = { qstashToken: 'tok', appUrl: APP_URL, cronSecret: SECRET };

  it('is live only when the token, the origin and the cron secret are all present', () => {
    expect(qstashTargetFor(complete)).toEqual({ appUrl: APP_URL, cronSecret: SECRET });
  });

  it.each([
    ['token', 'qstashToken'],
    ['origin', 'appUrl'],
    ['cron secret', 'cronSecret'],
  ] as const)('stays dormant when the %s is missing', (_label, key) => {
    // Partial configuration is the dangerous state: a message published without
    // a secret 401s forever, and one pointed at no origin cannot be delivered
    // at all. Both fail at delivery time, hours later, invisibly — so refuse to
    // be half-configured here instead.
    const partial = { ...complete, [key]: undefined };
    expect(qstashTargetFor(partial)).toBeNull();
  });
});

describe('the message shape the client is handed', () => {
  it('matches what @upstash/qstash batchJSON accepts', () => {
    // Guards the field names against a rename in the SDK's request type:
    // notBefore/deduplicationId are what QStash reads, and a typo in either
    // is accepted silently as an unknown field rather than rejected.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const message = nth(tickMessagesFor([release], opts(release - 60_000)), 0);

    expect(Object.keys(message).sort()).toEqual(
      ['deduplicationId', 'headers', 'notBefore', 'url'].sort(),
    );
  });
});
