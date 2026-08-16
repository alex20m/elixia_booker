import { describe, expect, it } from 'vitest';
import {
  API_DISCOVERED,
  DiscoveryIncompleteError,
  ElixiaClient,
  classifyBookingResponse,
  parseLoginResponse,
} from '../lib/elixia';
import { isRetryable } from '../lib/types';

/**
 * The endpoint values in src/elixia.ts are placeholders, but the *classification*
 * logic is real and is what the retry loop depends on. These tests pin the
 * status -> decision mapping so that replacing the placeholders later cannot
 * quietly change retry behaviour.
 */

const NOW = 1_700_000_000_000;

describe('the discovery guard', () => {
  it('is still off, because discovery has not run', () => {
    // If this ever fails, someone flipped the flag — make sure docs/api.md was
    // actually filled in first.
    expect(API_DISCOVERED).toBe(false);
  });

  it('refuses to issue a booking rather than firing at a guessed endpoint', async () => {
    const client = new ElixiaClient({
      fetchImpl: async () => {
        throw new Error('network must not be touched');
      },
    });

    await expect(
      client.book({ accessToken: 'a', expiresAtMs: NOW, updatedAtMs: NOW }, 'class-1', false),
    ).rejects.toThrow(DiscoveryIncompleteError);
  });

  it('points at docs/api.md in the error', async () => {
    const client = new ElixiaClient();
    await expect(client.login('a@b.c', 'pw', NOW)).rejects.toThrow(/docs\/api\.md/);
  });
});

describe('parseLoginResponse', () => {
  it('reads a camelCase token payload', () => {
    const tokens = parseLoginResponse(
      { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600 },
      NOW,
    );
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAtMs).toBe(NOW + 3_600_000);
  });

  it('reads a snake_case token payload', () => {
    const tokens = parseLoginResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 60 },
      NOW,
    );
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAtMs).toBe(NOW + 60_000);
  });

  it('assumes a short lifetime when none is given', () => {
    // Refreshing too early is cheap; discovering expiry at T-0 is not.
    const tokens = parseLoginResponse({ accessToken: 'at' }, NOW);
    expect(tokens.expiresAtMs).toBe(NOW + 300_000);
  });

  it('throws when the response carries no access token at all', () => {
    expect(() => parseLoginResponse({ nope: true }, NOW)).toThrow(/no access token/);
    expect(() => parseLoginResponse(null, NOW)).toThrow(/no access token/);
  });
});

describe('classifyBookingResponse', () => {
  it('treats 2xx as booked', () => {
    expect(classifyBookingResponse(201, '{"bookingId":55}')).toEqual({
      kind: 'booked',
      bookingId: '55',
    });
  });

  it('reads a booking id from an "id" field too', () => {
    expect(classifyBookingResponse(200, '{"id":7}')).toEqual({ kind: 'booked', bookingId: '7' });
  });

  it('still counts as booked when the body has no id', () => {
    expect(classifyBookingResponse(200, 'OK')).toEqual({ kind: 'booked' });
  });

  it('detects a waitlist placement in a success body', () => {
    expect(classifyBookingResponse(200, '{"status":"WAITLIST"}').kind).toBe('waitlisted');
  });

  it('maps 401 and 403 to unauthorized, which must not be retried', () => {
    for (const status of [401, 403]) {
      const outcome = classifyBookingResponse(status, 'nope');
      expect(outcome.kind).toBe('unauthorized');
      expect(isRetryable(outcome)).toBe(false);
    }
  });

  it('maps 429 to rate-limited and honours Retry-After in seconds', () => {
    const outcome = classifyBookingResponse(429, '', new Headers({ 'retry-after': '3' }));
    expect(outcome).toEqual({ kind: 'rate-limited', retryAfterMs: 3000 });
  });

  it('handles a Retry-After given as an HTTP date', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const outcome = classifyBookingResponse(429, '', new Headers({ 'retry-after': future }));
    expect(outcome.kind).toBe('rate-limited');
    expect((outcome as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('separates "already booked" from "full" — they need opposite handling', () => {
    expect(classifyBookingResponse(409, '{"error":"ALREADY_BOOKED"}').kind).toBe('already-booked');
    expect(classifyBookingResponse(409, '{"error":"CLASS_FULL"}').kind).toBe('full');
  });

  it('recognises a not-yet-open rejection as retryable', () => {
    for (const body of ['booking not open yet', 'TOO_EARLY', 'not yet available']) {
      const outcome = classifyBookingResponse(400, body);
      expect(outcome.kind).toBe('too-early');
      expect(isRetryable(outcome)).toBe(true);
    }
  });

  it('treats a 404 as too early, since an unopened class may not be addressable', () => {
    expect(classifyBookingResponse(404, '').kind).toBe('too-early');
  });

  it('falls back to a retryable error for an unrecognised 4xx body', () => {
    const outcome = classifyBookingResponse(422, '{"error":"SOMETHING_NEW"}');
    expect(outcome.kind).toBe('error');
    expect(isRetryable(outcome)).toBe(true);
  });

  it('treats 5xx as a retryable error', () => {
    const outcome = classifyBookingResponse(503, 'upstream down');
    expect(outcome.kind).toBe('error');
    expect(isRetryable(outcome)).toBe(true);
  });

  it('matches case-insensitively, since error casing is not guaranteed', () => {
    expect(classifyBookingResponse(409, 'Class Is Full').kind).toBe('full');
    expect(classifyBookingResponse(409, 'already registered').kind).toBe('already-booked');
  });

  it('truncates a huge error body so it cannot flood the log or notification', () => {
    const outcome = classifyBookingResponse(500, 'x'.repeat(10_000));
    const detail = (outcome as { detail: string }).detail;
    expect(detail.length).toBeLessThan(400);
  });
});
