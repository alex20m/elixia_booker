/**
 * Structured logging with timing relative to T-0.
 *
 * The question this log has to answer is "how close to the release instant did
 * the request actually land?", so every line carries its offset from T-0 in
 * milliseconds. Negative is early, positive is late. Without that number a
 * missed booking is unattributable — you cannot tell a wrong endpoint from a
 * cron that fired thirty seconds late.
 */

export interface LogEntry {
  ts: string;
  /** Milliseconds relative to T-0; negative means before the release instant. */
  offsetMs: number | null;
  event: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly entries: LogEntry[] = [];
  private targetEpochMs: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Set the reference instant that offsets are measured against. */
  setTarget(epochMs: number): void {
    this.targetEpochMs = epochMs;
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    const nowMs = this.now();
    const entry: LogEntry = {
      ts: new Date(nowMs).toISOString(),
      offsetMs: this.targetEpochMs === null ? null : nowMs - this.targetEpochMs,
      event,
      ...fields,
    };
    this.entries.push(entry);
    // console.log is what surfaces in `wrangler tail`.
    console.log(JSON.stringify(entry));
  }

  /** Everything logged so far, for building the notification summary. */
  all(): readonly LogEntry[] {
    return this.entries;
  }

  /**
   * Human-readable timing summary. Reads as a story of one attempt, which is
   * what you want in a Telegram message at 07:00.
   */
  timingSummary(): string {
    return this.entries
      .map((e) => {
        const offset = e.offsetMs === null ? '—' : `${e.offsetMs >= 0 ? '+' : ''}${e.offsetMs}ms`;
        return `${offset.padStart(9)}  ${e.event}`;
      })
      .join('\n');
  }
}
