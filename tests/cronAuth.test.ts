import { describe, expect, it } from 'vitest';
import { assertCronAuthorised } from '../lib/http';
import { ServiceError } from '../lib/service';
import type { SignatureVerifier } from '../lib/qstash';

/**
 * The cron endpoints are the one part of the app not protected by Neon auth:
 * they run for every user at once, with the service-role connection, bypassing
 * per-user scoping. If the guard were weak, anyone could fire other people's
 * booking attempts at will — or hammer Elixia from the app's address.
 *
 * The one credential accepted is a verified QStash signature, which QStash
 * attaches to every delivery automatically. There is deliberately no shared
 * secret to forward: QStash's own dashboard and events API show a message's
 * headers in the clear to anyone with account access, so a forwarded secret
 * would sit there in plaintext (see lib/qstash.ts's TickMessage comment).
 * Every test passes an explicit `verifier` so none of this depends on real
 * signing keys or real crypto.
 */

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

const requestWith = (opts: { authorization?: string; signature?: string } = {}): Request =>
  new Request('https://app.example.com/api/cron/tick', {
    method: 'POST',
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.signature ? { 'upstash-signature': opts.signature } : {}),
    },
  });

describe('assertCronAuthorised: a verified QStash signature', () => {
  it('accepts a request whose signature the verifier confirms', async () => {
    await expect(
      assertCronAuthorised(requestWith({ signature: 'sig' }), fakeVerifier(true)),
    ).resolves.not.toThrow();
  });

  it('rejects a signature the verifier refuses', async () => {
    await expect(
      assertCronAuthorised(requestWith({ signature: 'forged' }), fakeVerifier(false)),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('reads the request body once and hands it to the verifier', async () => {
    // The verifier needs the raw body; a body can only be read once, so the
    // guard must be the thing that consumes it.
    let seenBody: string | undefined;
    const verifier: SignatureVerifier = {
      async verify({ body }) {
        seenBody = body;
        return true;
      },
    };
    const request = new Request('https://app.example.com/api/cron/tick', {
      method: 'POST',
      body: 'the-raw-payload',
      headers: { 'upstash-signature': 'sig' },
    });

    await assertCronAuthorised(request, verifier);
    expect(seenBody).toBe('the-raw-payload');
  });
});

describe('assertCronAuthorised: a request that cannot be authenticated', () => {
  it('rejects a request with no signature header as Unauthorized', async () => {
    try {
      await assertCronAuthorised(requestWith(), fakeVerifier(true));
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(401);
      expect((err as Error).message).toBe('Unauthorized');
    }
  });

  it('ignores a Bearer token — the shared-secret path is gone', async () => {
    // Anything that is not a valid signature is not a credential any more.
    await expect(
      assertCronAuthorised(
        requestWith({ authorization: 'Bearer any-old-secret' }),
        fakeVerifier(true),
      ),
    ).rejects.toThrow(/Unauthorized/);
  });

  it('does not call the verifier when no signature header arrives', async () => {
    const verifier = fakeVerifier(true);
    await expect(assertCronAuthorised(requestWith(), verifier)).rejects.toThrow(ServiceError);
    expect(verifier.calls).toBe(0);
  });
});

describe('assertCronAuthorised: a deployment with no signing keys', () => {
  it('refuses every request, as a server error rather than a client rejection', async () => {
    // With no verifier there is no way to authenticate anyone, so falling open
    // is not an option. 500, not 401: this is the operator's problem and
    // should read that way in logs.
    try {
      await assertCronAuthorised(requestWith({ signature: 'sig' }), null);
      throw new Error('expected it to throw');
    } catch (err) {
      expect((err as ServiceError).status).toBe(500);
      expect((err as Error).message).toMatch(/signing keys/i);
    }
  });

  it('refuses an anonymous request the same way', async () => {
    await expect(assertCronAuthorised(requestWith(), null)).rejects.toThrow(/signing keys/i);
  });
});
