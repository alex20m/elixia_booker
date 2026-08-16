import { describe, expect, it } from 'vitest';
import { assertCronAuthorised } from '../lib/http';
import { ServiceError } from '../lib/service';

/**
 * The cron endpoints are the one part of the app not protected by Supabase
 * auth: they run for every user at once, with the service-role key, bypassing
 * row-level security. If the guard were weak, anyone could fire other people's
 * booking attempts at will — or hammer Elixia from the app's address.
 */

const SECRET = 'a-long-enough-cron-secret-value';

/** The configured secret, or undefined for a deployment that has none set. */
const configured = (cronSecret?: string): string | undefined => cronSecret;

const requestWith = (authorization?: string): Request =>
  new Request('https://app.example.com/api/cron/tick', {
    method: 'POST',
    ...(authorization ? { headers: { authorization } } : {}),
  });

describe('assertCronAuthorised', () => {
  it('accepts the configured secret', () => {
    expect(() =>
      assertCronAuthorised(requestWith(`Bearer ${SECRET}`), configured(SECRET)),
    ).not.toThrow();
  });

  it('rejects a request with no Authorization header', () => {
    expect(() => assertCronAuthorised(requestWith(), configured(SECRET))).toThrow(ServiceError);
  });

  it('rejects a wrong secret of the same length', () => {
    const wrong = 'x'.repeat(SECRET.length);
    expect(() => assertCronAuthorised(requestWith(`Bearer ${wrong}`), configured(SECRET))).toThrow(
      /Unauthorized/,
    );
  });

  it('rejects a secret that is a prefix of the real one', () => {
    // The case a naive startsWith comparison would wave through, and the one
    // that makes a secret recoverable a character at a time.
    expect(() =>
      assertCronAuthorised(requestWith(`Bearer ${SECRET.slice(0, -1)}`), configured(SECRET)),
    ).toThrow(/Unauthorized/);
  });

  it('rejects a secret with extra characters appended', () => {
    expect(() =>
      assertCronAuthorised(requestWith(`Bearer ${SECRET}extra`), configured(SECRET)),
    ).toThrow(/Unauthorized/);
  });

  it('rejects the right secret sent without the Bearer scheme', () => {
    expect(() => assertCronAuthorised(requestWith(SECRET), configured(SECRET))).toThrow(
      /Unauthorized/,
    );
  });

  it('refuses to run at all when the deployment has no secret configured', () => {
    // Silently allowing the tick would be far worse than refusing it: an
    // unguarded endpoint is discoverable, and its whole job is to act for
    // every user.
    expect(() => assertCronAuthorised(requestWith(`Bearer ${SECRET}`), configured())).toThrow(
      /CRON_SECRET/,
    );
  });

  it('rejects an anonymous request before revealing anything about the deployment', () => {
    // Ordering matters: the route must authorise first, so an unauthenticated
    // caller gets a flat 401 rather than a 500 describing the configuration.
    try {
      assertCronAuthorised(requestWith(), configured(SECRET));
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(401);
      expect((err as Error).message).toBe('Unauthorized');
    }
  });

  it('reports a missing secret as a server error, not as a client rejection', () => {
    // 401 would suggest the caller sent the wrong thing; this is the operator's
    // problem and should read that way in logs.
    try {
      assertCronAuthorised(requestWith(`Bearer ${SECRET}`), configured());
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(500);
    }
  });
});
