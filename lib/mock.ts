/**
 * A stand-in Elixia backend.
 *
 * Elixia's real API is still undiscovered, which would otherwise make the whole
 * application undemonstrable — you could not sign in, so you could not see the
 * UI, so nothing could be tested end to end. This backend closes that gap: with
 * MOCK_ELIXIA=1 the app is fully usable, and every layer above the adapter
 * (sign-in, encryption, subscriptions, the due index, the cron, notifications,
 * history) exercises its real code path.
 *
 * It is enabled only by explicit opt-in, and every booking it reports carries a
 * mock marker, so it cannot be mistaken for a real one.
 */

import type { BookingBackend } from './elixia';
import type { AttemptOutcome, StoredTokens, Subscription } from './types';

/** Access tokens are short-lived so the refresh path actually gets exercised. */
const MOCK_TOKEN_TTL_MS = 10 * 60 * 1000;

export class MockElixiaClient implements BookingBackend {
  async login(email: string, password: string, nowMs: number): Promise<StoredTokens> {
    // Enough validation to exercise the failure path in the UI.
    if (!email.includes('@')) throw new Error('That does not look like an email address');
    if (password.length < 4) throw new Error('Incorrect email or password');

    return {
      accessToken: `mock-access-${nowMs}`,
      refreshToken: `mock-refresh-${nowMs}`,
      expiresAtMs: nowMs + MOCK_TOKEN_TTL_MS,
      updatedAtMs: nowMs,
    };
  }

  async refresh(tokens: StoredTokens, nowMs: number): Promise<StoredTokens> {
    if (!tokens.refreshToken) throw new Error('no refresh token');
    return {
      accessToken: `mock-access-${nowMs}`,
      refreshToken: `mock-refresh-${nowMs}`,
      expiresAtMs: nowMs + MOCK_TOKEN_TTL_MS,
      updatedAtMs: nowMs,
    };
  }

  async resolveClassId(
    _tokens: StoredTokens,
    subscription: Subscription,
    classDate: string,
  ): Promise<string> {
    return `mock-${subscription.className.toLowerCase().replace(/\s+/g, '-')}-${classDate}`;
  }

  /**
   * Outcome is driven by the class name so every branch is reachable by hand:
   * a class named "…full" comes back full, "…busy" rejects once as too-early
   * before succeeding, and anything else books.
   */
  async book(
    _tokens: StoredTokens,
    classId: string,
    waitlist: boolean,
  ): Promise<AttemptOutcome> {
    const id = classId.toLowerCase();

    if (id.includes('full')) {
      return waitlist ? { kind: 'waitlisted', position: 3 } : { kind: 'full' };
    }
    if (id.includes('busy') && !this.busySeen.has(classId)) {
      this.busySeen.add(classId);
      return { kind: 'too-early' };
    }
    return { kind: 'booked', bookingId: `MOCK-${classId}` };
  }

  private readonly busySeen = new Set<string>();
}

export function isMockEnabled(value: string | undefined): boolean {
  const v = (value ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
