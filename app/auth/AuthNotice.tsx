'use client';

import { useSearchParams } from 'next/navigation';

/**
 * What a verification link says when it did not work.
 *
 * `/api/auth/[...path]` settles the link itself and then sends the browser
 * here rather than leaving it on an API URL looking at a JSON error, so this
 * is the only place the visitor learns anything about it. The codes are Better
 * Auth's own; anything unrecognised gets the general sentence rather than the
 * code, which would mean nothing to the person reading it.
 */
const MESSAGES: Record<string, string> = {
  TOKEN_EXPIRED: 'That verification link has expired. Sign in below to continue.',
  INVALID_TOKEN:
    'That verification link did not work — it may have already been used. Sign in below to continue.',
};

const FALLBACK = 'That verification link did not work. Sign in below to continue.';

/**
 * Rendered above the auth card. It reads the query string on the client, which
 * is what keeps these pages statically rendered: nothing on the server depends
 * on the parameter, and the pages are prerendered at build time from
 * `generateStaticParams`.
 */
export function AuthNotice() {
  const error = useSearchParams().get('error');
  if (!error) return null;

  return (
    <div className="banner banner-warn" id="auth-notice">
      <span>{MESSAGES[error] ?? FALLBACK}</span>
    </div>
  );
}
