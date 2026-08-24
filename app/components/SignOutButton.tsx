'use client';

import { authClient } from '@/lib/auth/client';
import { ActionButton } from './ActionButton';

/**
 * Signing out, which is a network round trip like any other.
 *
 * Its own component because it appears in three places, and because a press
 * that looks ignored is the press people repeat — here that means two sign-out
 * requests and, on a slow connection, someone tapping a button that has already
 * worked.
 */
export function SignOutButton({
  id,
  className,
  icon,
}: {
  id?: string;
  className?: string;
  /** For the menu, where every row is an icon and a label. */
  icon?: React.ReactNode;
}) {
  return (
    <ActionButton
      id={id}
      className={className}
      pendingLabel="Signing out…"
      onClick={() => authClient.signOut()}
    >
      {icon}
      <span>Sign out</span>
    </ActionButton>
  );
}
