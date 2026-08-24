'use client';

import Link from 'next/link';
import { SignOutButton } from './components/SignOutButton';

/**
 * Identity — name, email, password, and account deletion — owned by Neon
 * Auth's own account page rather than reimplemented here (see
 * app/account/page.tsx).
 *
 * One link, not two: Neon Auth's account pages used to split this across an
 * "Account" tab and a "Security" tab, switched between by a sidebar nav item
 * that collapsed into a hamburger drawer on phones — a drawer that never
 * opened. The single combined page removes the need for that nav entirely.
 *
 * Labelled generically rather than by the fields it holds: it used to read
 * "Name, email & password", which named three of the four cards behind it and
 * gave nobody reason to expect the fourth — delete account — to be there too.
 */
export function AccountCard() {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Account</h2>
      </div>
      <div className="stack">
        <Link className="btn btn-secondary btn-block" id="account-settings-btn" href="/account">
          Account settings
        </Link>
        <SignOutButton className="btn-quiet btn-block" />
      </div>
    </section>
  );
}
