'use client';

import Link from 'next/link';
import { SignOutButton } from './components/SignOutButton';

/**
 * Identity — password, email, sign-in — all owned by Neon Auth's own account
 * pages rather than reimplemented here (see app/account/[path]/page.tsx).
 *
 * Two links, not one: Neon Auth splits its account pages into an "Account"
 * tab (display name, connected sign-in methods) and a "Security" tab, and
 * password change lives on Security. A single link into the Account tab left
 * the password field reachable only via a sidebar nav item — a hamburger
 * drawer on phones — that nothing here pointed at, which is exactly why it
 * went unfound. Naming the destination is what fixes that.
 */
export function AccountCard() {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Account</h2>
      </div>
      <div className="stack">
        <Link
          className="btn btn-secondary btn-block"
          id="account-password-btn"
          href="/account/security"
        >
          Change password
        </Link>
        <Link className="btn btn-quiet btn-block" id="account-settings-btn" href="/account/settings">
          Email &amp; sign-in details
        </Link>
        <SignOutButton className="btn-quiet btn-block" />
      </div>
    </section>
  );
}
