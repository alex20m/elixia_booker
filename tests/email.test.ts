import { describe, expect, it, vi } from 'vitest';
import { isValidFromAddress, sendEmail } from '@/lib/email';

/**
 * Email delivery, which is the default channel and therefore the one most
 * users never configure — so its no-op and failure paths matter more than its
 * happy path. Like Telegram, a send that fails must report rather than throw:
 * the booking it is describing has already happened.
 *
 * Resend's HTTP API is the transport. The request shape is asserted here
 * because nothing else can check it — the sandbox cannot reach the real API,
 * and a payload the service rejects would otherwise only surface in
 * production, as an alert nobody received.
 */

const CONFIG = { resendApiKey: 're_test_key', notifyFromEmail: 'Booker <bot@example.com>' };

const okFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));

describe('sendEmail', () => {
  it('posts the message to Resend for the address given', async () => {
    const fetchImpl = okFetch();

    const result = await sendEmail(
      { ...CONFIG, to: 'user@example.com', subject: 'Booked', text: 'Booked your class' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result).toEqual({ sent: true, attempted: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body)).toMatchObject({
      from: 'Booker <bot@example.com>',
      to: ['user@example.com'],
      subject: 'Booked',
      text: 'Booked your class',
    });
  });

  it('is a silent no-op for a user with no address on file', async () => {
    const fetchImpl = okFetch();

    const result = await sendEmail(
      { ...CONFIG, to: undefined, subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op when the operator configured no Resend key', async () => {
    const fetchImpl = okFetch();

    const result = await sendEmail(
      { resendApiKey: undefined, notifyFromEmail: CONFIG.notifyFromEmail, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op when no sender address is configured, which Resend would reject anyway', async () => {
    const fetchImpl = okFetch();

    const result = await sendEmail(
      { resendApiKey: 're_k', notifyFromEmail: undefined, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op for a malformed sender address, instead of spending a request on Resend rejecting it every time', async () => {
    // The reported bug this guards: NOTIFY_FROM_EMAIL set to
    // "Elixia Booker <noreply@alexmecklin.com" — missing the closing `>` —
    // which Resend's API rejects with a 422 on every single attempt. Catching
    // it here means it shows up as "not configured" up front rather than only
    // after a wasted call that fails the same way forever.
    const fetchImpl = okFetch();

    const result = await sendEmail(
      {
        resendApiKey: 're_k',
        notifyFromEmail: 'Elixia Booker <noreply@alexmecklin.com',
        to: 'u@e.com',
        subject: 's',
        text: 't',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports rather than throws when Resend rejects the message', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"domain not verified"}', { status: 403 }));

    const result = await sendEmail(
      { ...CONFIG, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(result.reason).toContain('403');
  });

  it('swallows a network failure so a booking result is never lost to it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.resend.com');
    });

    const result = await sendEmail(
      { ...CONFIG, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.sent).toBe(false);
    expect(result.reason).toContain('ENOTFOUND');
  });

  it('never puts the API key in the reason it reports, which is logged', async () => {
    // Some fetch failures carry the whole request — headers included — in the
    // error text. That text goes to the log, so the key has to be scrubbed on
    // the way out or the log becomes the leak.
    const fetchImpl = vi.fn(async () => {
      throw new Error('request failed: authorization: Bearer re_test_key');
    });

    const result = await sendEmail(
      { ...CONFIG, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result.reason).not.toContain('re_test_key');
    expect(result.reason).toContain('[redacted]');
  });

  it('gives up on a send that never answers, instead of holding up the booking run', async () => {
    // A request that is accepted and then hangs is the dangerous case: it is
    // awaited inline in the per-user loop, so without a deadline one stalled
    // send costs everyone later in that tick their booking window.
    const fetchImpl = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const result = await sendEmail(
      { ...CONFIG, to: 'u@e.com', subject: 's', text: 't' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 },
    );

    expect(result.sent).toBe(false);
  }, 2000);
});

describe('isValidFromAddress', () => {
  it('accepts a bare email address', () => {
    expect(isValidFromAddress('bot@example.com')).toBe(true);
  });

  it('accepts "Name <email>"', () => {
    expect(isValidFromAddress('Elixia Booker <noreply@alexmecklin.com>')).toBe(true);
  });

  it('rejects a "Name <email>" address missing its closing bracket', () => {
    // Exactly the value NOTIFY_FROM_EMAIL was set to when this shipped: valid
    // enough to look right at a glance, and rejected by Resend's API on every
    // single send.
    expect(isValidFromAddress('Elixia Booker <noreply@alexmecklin.com')).toBe(false);
  });

  it('rejects an opening bracket with no matching close', () => {
    expect(isValidFromAddress('<noreply@alexmecklin.com')).toBe(false);
  });

  it('rejects text with no @ at all', () => {
    expect(isValidFromAddress('Elixia Booker')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isValidFromAddress('  bot@example.com  ')).toBe(true);
  });
});
