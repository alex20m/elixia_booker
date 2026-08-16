/**
 * Session freshness rules.
 *
 * The app never holds a password. Each user's Elixia session is obtained when
 * they sign in through the UI and then kept alive by refreshing; the tokens
 * themselves live encrypted in KV (see store/users.ts).
 *
 * An unrecoverable session is a loud failure, never a silent skip: it needs the
 * user to sign in again, and a bot that hides that just misses every booking
 * from then on.
 */

import type { StoredTokens } from './types';

/**
 * Refresh this long before the token actually expires. Covers clock skew
 * between the Worker and Elixia, and means a token that would have expired
 * mid-run was already replaced before the critical path.
 */
export const REFRESH_SKEW_MS = 120_000;

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export function needsRefresh(tokens: StoredTokens, nowMs: number): boolean {
  return tokens.expiresAtMs - REFRESH_SKEW_MS <= nowMs;
}
