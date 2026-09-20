/**
 * Timing defaults shared by every user's booking run.
 *
 * The per-user list of classes lives in KV (see store/users.ts), not here —
 * this is a hosted app, so there is no compiled-in configuration to edit and
 * redeploy. Only the mechanical timings are global.
 */

export const DEFAULT_TIMINGS = {
  /**
   * Fire this many ms before the computed release instant, to absorb network
   * latency. Keep small — too eager and the server rejects the attempt as early.
   */
  leadMs: 0,
  /** Total wall-clock budget for the retry loop. */
  retryBudgetMs: 30_000,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 5_000,
  /**
   * The probe cadence while a class is merely not listed yet.
   *
   * One second is a deliberate trade. The worst case it allows is a booking
   * that goes out a second after Elixia publishes the class; the exponential
   * grid alone allowed five, and — because the delay keeps growing — allowed
   * two people waiting on the same class to reach it five seconds apart. The
   * cost is request volume in the one case where the class never appears at
   * all: roughly forty page reads spread across the 30s budget rather than a
   * dozen, which is still well under one request per second and below what a
   * person refreshing the page by hand produces. In the normal case the class
   * appears within a probe or two and the volume is unchanged.
   */
  listingPollMaxDelayMs: 1_000,
  /**
   * 1.5s before firing: long enough that a probe on a slow connection can
   * still land before T-0, short enough that the connection it opens is
   * still alive when the booking request needs it.
   */
  preflightMs: 1_500,
  /**
   * How far ahead of a release the cron will claim it. Comfortably wider than
   * the one-minute tick, so a release cannot fall between two runs unclaimed.
   */
  claimHorizonMs: 90_000,
  /**
   * How late a release may still be claimed. Cloudflare's cron firing is
   * approximate; without grace, a run starting a few seconds late would skip
   * the slot rather than trying immediately.
   */
  claimGraceMs: 120_000,
} as const;
