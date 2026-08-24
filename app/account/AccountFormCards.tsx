'use client';

import { useContext } from 'react';
import {
  AuthUIContext,
  ChangeEmailCard,
  ChangePasswordCard,
  DeleteAccountCard,
  UpdateNameCard,
  useAuthenticate,
} from '@neondatabase/auth-ui';

/**
 * The four cards that used to live on Neon Auth's own /account/settings and
 * /account/security pages, combined onto one page. Deliberately omits
 * SessionsCard (the "sessions" section the settings menu doesn't need) and the
 * avatar/username/2FA/passkey/provider cards this app never enables.
 *
 * DeleteAccountCard has to stay: it's the only place in the app a user can
 * ask to delete their account at all, and app/api/auth/[...path]/route.ts
 * purges the app's own data (subscriptions, the sealed Elixia secret,
 * history) the moment this card's dialog confirms the deletion — with no
 * entry point to trigger it, that cleanup would never run.
 *
 * The `account` check mirrors AccountView's own guard: at build time this page
 * renders with no AuthUIProvider above it, so the context falls back to `{}`
 * and every card below would crash reading `hooks.useSession` off it. Bailing
 * out here, before the cards render, is what keeps `next build` static
 * generation working the same way it did through AccountView. The check and
 * the hook-bearing cards live in separate components so neither calls a hook
 * conditionally.
 */
export function AccountFormCards() {
  const { account } = useContext(AuthUIContext);
  if (!account) {
    return null;
  }

  return <AuthenticatedAccountFormCards />;
}

function AuthenticatedAccountFormCards() {
  useAuthenticate();

  return (
    <div className="flex w-full flex-col gap-4 md:gap-6">
      <UpdateNameCard />
      <ChangeEmailCard />
      <ChangePasswordCard />
      <DeleteAccountCard />
    </div>
  );
}
