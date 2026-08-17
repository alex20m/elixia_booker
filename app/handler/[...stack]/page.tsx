import { StackHandler } from '@stackframe/stack';

/**
 * Every Neon Auth page — sign in, sign up, email verification, forgotten
 * password, account settings — served under /handler/*.
 *
 * These flows are the reason identity is not hand-rolled here. A password reset
 * that works needs an email sender, single-use tokens and rate limiting; this
 * file is what buying them costs.
 */
export default function Handler(props: unknown) {
  return <StackHandler fullPage {...(props as object)} />;
}
