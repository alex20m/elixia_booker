'use client';

import { NeonAuthUIProvider } from '@neondatabase/auth-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth/client';

/**
 * The wording on Neon's auth screens, where its defaults say something other
 * than the rest of the app does.
 *
 * Two kinds of change only. The first is vocabulary: this app says "sign in"
 * everywhere, and the stock button says "Login" — one product should not call
 * the same act two things on the same tap. The second is the placeholder in
 * the email field. `m@example.com` reads as a value someone left in rather
 * than an example, and an address that looks half-typed invites people to
 * complete it instead of replacing it; `you@example.com` says whose address
 * belongs there.
 *
 * Everything not listed here keeps Neon's own copy, which is why this is a
 * partial override rather than a translation file.
 */
const LOCALIZATION = {
  SIGN_IN: 'Sign in',
  SIGN_IN_ACTION: 'Sign in',
  SIGN_IN_DESCRIPTION: 'Enter the email and password you signed up with.',
  SIGN_UP: 'Create your account',
  SIGN_UP_ACTION: 'Create account',
  SIGN_UP_DESCRIPTION: 'Takes a minute. You will get an email to confirm the address.',
  SIGN_UP_EMAIL: 'Check your email for the link that finishes signing you in.',
  EMAIL_PLACEHOLDER: 'you@example.com',
  FORGOT_PASSWORD_DESCRIPTION: 'Enter your email and we will send you a link to set a new password.',
};

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <NeonAuthUIProvider
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => router.refresh()}
      redirectTo="/"
      localization={LOCALIZATION}
      Link={Link}
    >
      {children}
    </NeonAuthUIProvider>
  );
}
