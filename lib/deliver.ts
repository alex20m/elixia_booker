/**
 * The mechanics every notification channel shares.
 *
 * Both channels are HTTP POSTs to a third-party API carrying an operator
 * secret, and both are called from inside the booking loop. That gives them
 * three obligations in common, which is why they are implemented once here
 * rather than twice:
 *
 *   - **Never throw.** A booking that succeeded must not be reported as failed
 *     because the thing announcing it was down. Every path returns a status.
 *   - **Never hang.** `notifyUser` is awaited inline in the per-user loop, so a
 *     request that is accepted and then never answered costs every user later
 *     in that tick their booking window. A dead notifier is an inconvenience; a
 *     notifier that stalls the run is an outage.
 *   - **Never leak the key.** The reason a failure reports is written to the
 *     log, and some fetch failures quote the whole request back — headers and
 *     all. Anything reported out of here goes through `redact` first.
 */

export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

/**
 * How long a single send may take.
 *
 * Generous next to a booking attempt, because being late with an alert costs
 * nothing, and stingy next to the serverless invocation's own ceiling, because
 * the tick has other users waiting behind this one.
 */
export const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * Blank out operator secrets in text that is about to be logged.
 *
 * The bot token sits in Telegram's URL path and the Resend key sits in an
 * Authorization header, so both end up inside error text that quotes the
 * request. Short values are ignored: redacting a one-character "secret" would
 * scrub unrelated text into uselessness.
 */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PostJsonRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Names the service in any reason reported, e.g. "telegram". */
  service: string;
  /** Values scrubbed out of whatever this reports. */
  secrets: Array<string | undefined>;
}

/**
 * POST JSON, and turn every outcome — including the ones that are not
 * responses — into a `NotifyResult`.
 *
 * The deadline is a race rather than only an `AbortSignal`, because a signal
 * bounds the request just so long as whatever implements `fetch` honours it.
 * The race bounds the *caller* regardless, which is the property the booking
 * loop actually needs. The signal is still passed, so a bounded request is also
 * cancelled rather than merely abandoned.
 */
export async function postJson(
  request: PostJsonRequest,
  options: DeliverOptions = {},
): Promise<NotifyResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<NotifyResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ sent: false, reason: `${request.service} did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
  });

  const send = async (): Promise<NotifyResult> => {
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { sent: false, reason: `${request.service} returned HTTP ${response.status}` };
      }
      return { sent: true };
    } catch (err) {
      const message = redact((err as Error).message, request.secrets);
      return { sent: false, reason: `${request.service} request failed: ${message}` };
    }
  };

  try {
    return await Promise.race([send(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
