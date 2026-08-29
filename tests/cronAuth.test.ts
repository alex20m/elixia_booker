import { describe, expect, it } from 'vitest';
import { assertCronAuthorised } from '../lib/http';
import { ServiceError } from '../lib/service';
import type { SignatureVerifier } from '../lib/qstash';

/**
 * The cron endpoints are the one part of the app not protected by Neon
 * auth: they run for every user at once, with the service-role key, bypassing
 * row-level security. If the guard were weak, anyone could fire other people's
 * booking attempts at will — or hammer Elixia from the app's address.
 *
 * Two credentials are accepted, checked cheapest-first: the shared
 * CRON_SECRET (what GitHub Actions still sends) and a verified QStash
 * signature (what QStash's own deliveries carry automatically, without the
 * app ever forwarding a secret into QStash's own logs — see lib/qstash.ts's
 * TickMessage comment for why that mattered). Every test here passes an
 * explicit `verifier`, `null` unless it is the thing under test, so none of
 * this depends on real signing keys or real crypto.
 */

const SECRET = 'a-long-enough-cron-secret-value';

/** The configured secret, or undefined for a deployment that has none set. */
const configured = (cronSecret?: string): string | undefined => cronSecret;

const requestWith = (opts: { authorization?: string; signature?: string } = {}): Request =>
  new Request('https://app.example.com/api/cron/tick', {
    method: 'POST',
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.signature ? { 'upstash-signature': opts.signature } : {}),
    },
  });

/** A verifier that always agrees or always refuses, and records whether it ran. */
function fakeVerifier(result: boolean): SignatureVerifier & { calls: number } {
  const verifier = {
    calls: 0,
    async verify() {
      verifier.calls += 1;
      return result;
    },
  };
  return verifier;
}

describe('assertCronAuthorised: the shared secret', () => {
  it('accepts the configured secret', async () => {
    await expect(
      assertCronAuthorised(requestWith({ authorization: `Bearer ${SECRET}` }), configured(SECRET), null),
    ).resolves.not.toThrow();
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(assertCronAuthorised(requestWith(), configured(SECRET), null)).rejects.toThrow(
      ServiceError,
    );
  });

  it('rejects a wrong secret of the same length', async () => {
    const wrong = 'x'.repeat(SECRET.length);
    await expect(
      assertCronAuthorised(requestWith({ authorization: `Bearer ${wrong}` }), configured(SECRET), null),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('rejects a secret that is a prefix of the real one', async () => {
    // The case a naive startsWith comparison would wave through, and the one
    // that makes a secret recoverable a character at a time.
    await expect(
      assertCronAuthorised(
        requestWith({ authorization: `Bearer ${SECRET.slice(0, -1)}` }),
        configured(SECRET),
        null,
      ),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('rejects a secret with extra characters appended', async () => {
    await expect(
      assertCronAuthorised(requestWith({ authorization: `Bearer ${SECRET}extra` }), configured(SECRET), null),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('rejects the right secret sent without the Bearer scheme', async () => {
    await expect(
      assertCronAuthorised(requestWith({ authorization: SECRET }), configured(SECRET), null),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('refuses to run at all when the deployment has no secret and no signature arrives', async () => {
    // Silently allowing the tick would be far worse than refusing it: an
    // unguarded endpoint is discoverable, and its whole job is to act for
    // every user.
    await expect(
      assertCronAuthorised(requestWith({ authorization: `Bearer ${SECRET}` }), configured(), null),
    ).rejects.toThrow(/CRON_SECRET/);
  });

  it('rejects an anonymous request before revealing anything about the deployment', async () => {
    // Ordering matters: the route must authorise first, so an unauthenticated
    // caller gets a flat 401 rather than a 500 describing the configuration.
    try {
      await assertCronAuthorised(requestWith(), configured(SECRET), null);
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(401);
      expect((err as Error).message).toBe('Unauthorized');
    }
  });

  it('reports a missing secret as a server error, not as a client rejection', async () => {
    // 401 would suggest the caller sent the wrong thing; this is the operator's
    // problem and should read that way in logs.
    try {
      await assertCronAuthorised(requestWith({ authorization: `Bearer ${SECRET}` }), configured(), null);
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(500);
    }
  });
});

describe('assertCronAuthorised: the QStash signature', () => {
  it('accepts a verified signature with no Authorization header at all', async () => {
    // This is the whole point: QStash's own deliveries never carry the
    // secret, so this is the only credential they can present.
    await expect(
      assertCronAuthorised(requestWith({ signature: 'sig' }), configured(SECRET), fakeVerifier(true)),
    ).resolves.not.toThrow();
  });

  it('rejects a signature the verifier refuses', async () => {
    await expect(
      assertCronAuthorised(requestWith({ signature: 'forged' }), configured(SECRET), fakeVerifier(false)),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('never calls the verifier once the shared secret already matched', async () => {
    // Cheapest check first: no reason to read the body and run signature
    // verification for a caller that already authenticated.
    const verifier = fakeVerifier(true);
    await assertCronAuthorised(requestWith({ authorization: `Bearer ${SECRET}` }), configured(SECRET), verifier);

    expect(verifier.calls).toBe(0);
  });

  it('does not crash when a signature header arrives but no verifier is configured', async () => {
    // Signing keys are optional configuration (qstashSigningKeysFor). An
    // attacker sending a bogus header must not turn an absent verifier into a
    // 500 that leaks anything about the deployment.
    await expect(
      assertCronAuthorised(requestWith({ signature: 'whatever' }), configured(SECRET), null),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('accepts a verified signature even when CRON_SECRET is not configured', async () => {
    // A cryptographically verified request is not the "unguarded endpoint"
    // the CRON_SECRET check exists to catch — a deployment can run on
    // signing keys alone.
    await expect(
      assertCronAuthorised(requestWith({ signature: 'sig' }), configured(), fakeVerifier(true)),
    ).resolves.not.toThrow();
  });
});
