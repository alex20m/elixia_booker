/**
 * Email notifications, via Resend's HTTP API.
 *
 * Email is the default channel because it is the only one that needs nothing
 * from the user: the address arrives with the Neon Auth session, so a new
 * account is reachable before it has visited Settings. Telegram is the opt-in
 * upgrade for anyone who wants their phone to buzz.
 *
 * HTTP rather than SMTP deliberately — SMTP means a long-lived credential, a
 * dependency, and ports that serverless platforms treat as optional. This is
 * one POST, the same shape as the Telegram call next door.
 *
 * The request follows Resend's documented send-email shape
 * (https://resend.com/docs/api-reference/emails/send-email): bearer key,
 * `from` / `to` / `subject` / `text`. Nothing in CI can reach the real API to
 * confirm it, which is exactly why `sendEmail` degrades to a reported failure
 * rather than an exception — a payload the service disliked costs an alert,
 * never a booking.
 */

import { postJson, type DeliverOptions, type NotifyResult } from './deliver';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface EmailRequest {
  /** Operator's Resend key. Absent on a deployment that never set one up. */
  resendApiKey?: string;
  /** Operator's verified sender, e.g. `Booker <bot@example.com>`. */
  notifyFromEmail?: string;
  /** The user's address. Absent for a profile created before we had one. */
  to?: string;
  subject: string;
  text: string;
}

/**
 * Send one notification email.
 *
 * The three missing-configuration cases are *not* errors and must never be
 * treated as such: a deployment with no Resend key, an operator with no
 * verified sender, and a user with no address on file are all ordinary states
 * in which the app simply has nobody to tell. Failing here would fail a
 * booking run that worked.
 */
export async function sendEmail(
  request: EmailRequest,
  options: DeliverOptions = {},
): Promise<NotifyResult> {
  const { resendApiKey, notifyFromEmail, to, subject, text } = request;

  if (!resendApiKey) return { sent: false, reason: 'no Resend API key configured' };
  if (!notifyFromEmail) return { sent: false, reason: 'no sender address configured' };
  if (!to) return { sent: false, reason: 'no email address on file for this user' };

  return postJson(
    {
      url: RESEND_ENDPOINT,
      headers: { authorization: `Bearer ${resendApiKey}` },
      // An array even for one recipient: Resend accepts both, and the array
      // form is the one that stays correct if this ever sends to two.
      body: { from: notifyFromEmail, to: [to], subject, text },
      service: 'resend',
      secrets: [resendApiKey],
    },
    options,
  );
}
