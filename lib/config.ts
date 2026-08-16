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
