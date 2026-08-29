import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  TICK_LEAD_MS,
  tickMessagesFor,
  scheduleBookingTicks,
  qstashTargetFor,
  TICK_TIMEOUT_SECONDS,
  TICK_MAX_DURATION_SECONDS,
  type TickMessage,
} from '@/lib/qstash';
import { DEFAULT_TIMINGS } from '@/lib/config';

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
      ['deduplicationId', 'headers', 'notBefore', 'timeout', 'url'].sort(),
    );
  });
});

describe("staying inside QStash's maximum scheduling delay", () => {
  /**
   * Verified against the live account on 2026-08-29 by publishing probe
   * batches: QStash answers a message scheduled further out than the plan
   * allows with `{"error":"quota maxDelay exceeded, current limit: 604800"}`,
   * and 604800s is seven days.
   */
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.parse('2026-08-29T08:00:00.000Z');

  /**
   * A publisher that fails the way the real one does.
   *
   * The single most expensive detail: QStash validates the whole batch before
   * accepting any of it, so one over-limit message rejects *every* message in
   * the request — including the ones well inside the limit. A fake that
   * dropped only the offending message would let the bug this describes ship.
   */
  function fakeQstash() {
    const accepted: TickMessage[] = [];
    const batchJSON = vi.fn(async (messages: TickMessage[]) => {
      const tooFar = messages.filter((m) => m.notBefore * 1000 - nowMs > SEVEN_DAYS_MS);
      if (tooFar.length > 0) {
        throw new Error('quota maxDelay exceeded, current limit: 604800');
      }
      accepted.push(...messages);
      return [];
    });
    return { batchJSON, accepted };
  }

  it('never asks QStash for a delivery beyond the delay its plan allows', () => {
    // Ten days is what REINDEX_HORIZON_DAYS projects, and seven is all QStash
    // will take. Asking anyway is not a partial success — it is a rejected
    // request.
    const messages = tickMessagesFor([nowMs + 8 * 24 * 60 * 60 * 1000], opts(nowMs));

    expect(messages).toEqual([]);
  });

  it('still schedules the imminent releases when a later one is out of range', async () => {
    // The bug this is the regression test for. The nightly reindex projects a
    // ten-day horizon, so any weekly subscription puts an over-limit instant in
    // the same batch as tomorrow's. QStash rejected the batch whole, the error
    // was swallowed, and the booking due in 24 hours had no message at all
    // while its row sat in the database looking perfectly healthy.
    const tomorrow = nowMs + 1 * 24 * 60 * 60 * 1000;
    const nextWeek = nowMs + 9 * 24 * 60 * 60 * 1000;
    const qstash = fakeQstash();

    const result = await scheduleBookingTicks([tomorrow, nextWeek], {
      ...opts(nowMs),
      publisher: qstash,
    });

    expect(result.error).toBeUndefined();
    expect(result.scheduled).toBe(1);
    expect(qstash.accepted.map((m) => m.notBefore * 1000)).toEqual([tomorrow - TICK_LEAD_MS]);
  });

  it('keeps a margin under the limit so publish latency cannot push a message over', () => {
    // notBefore is fixed when the batch is built, but QStash measures the delay
    // when it receives it. A release computed at exactly the ceiling arrives
    // just past it, and takes the whole batch down with it.
    const atTheLimit = nowMs + SEVEN_DAYS_MS;

    expect(tickMessagesFor([atTheLimit], opts(nowMs))).toEqual([]);
  });
});

describe('how long a published tick may hold its connection', () => {
  it('tells QStash the timeout instead of inheriting the plan default', () => {
    // An unset timeout means "whatever this plan happens to allow", which is a
    // number nobody here chose and that changes with the plan. State it.
    const release = Date.parse('2026-09-01T10:00:00.000Z');
    const message = nth(tickMessagesFor([release], opts(release - 60_000)), 0);

    expect(message.timeout).toBe(TICK_TIMEOUT_SECONDS);
  });

  it('leaves the tick room for its lead, its retries and writing the result', () => {
    // The real ceiling is Vercel's maxDuration on /api/cron/tick, not QStash's.
    // The handler wakes at T-minus-lead, sleeps to T-0, then retries for the
    // whole budget. If those stop fitting under the ceiling the platform kills
    // the invocation mid-attempt and nothing is ever written down.
    const held = TICK_LEAD_MS + DEFAULT_TIMINGS.retryBudgetMs;

    expect(held).toBeLessThan(TICK_TIMEOUT_SECONDS * 1000);
    expect(TICK_TIMEOUT_SECONDS).toBeLessThanOrEqual(TICK_MAX_DURATION_SECONDS);
  });
});

describe("the route's own duration ceiling", () => {
  it('matches the ceiling the published timeout is sized against', () => {
    // Next.js requires route segment config to be a statically analysable
    // literal — importing the constant makes the build fail with "Invalid
    // segment configuration export detected". So the number is written out in
    // the route, and this is what stops the two copies drifting: shrink the
    // route's budget without shrinking the timeout and QStash keeps waiting
    // for an invocation the platform has already killed.
    const route = readFileSync(
      fileURLToPath(new URL('../app/api/cron/tick/route.ts', import.meta.url)),
      'utf8',
    );
    const declared = /export const maxDuration = (\d+);/.exec(route)?.[1];

    expect(declared).toBeDefined();
    expect(Number(declared)).toBe(TICK_MAX_DURATION_SECONDS);
  });
});
