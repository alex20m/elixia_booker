'use client';

import Link from 'next/link';
import { authClient } from '@/lib/auth/client';

/**
 * Identity — name, email, password — owned by Neon Auth's own account page
 * rather than reimplemented here (see app/account/page.tsx).
 *
 * One link, not two: Neon Auth's account pages used to split this across an
 * "Account" tab and a "Security" tab, switched between by a sidebar nav item
 * that collapsed into a hamburger drawer on phones — a drawer that never
 * opened. The single combined page removes the need for that nav entirely.
 */
export function AccountCard() {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Account</h2>
      </div>
      <div className="stack">
        <Link className="btn btn-secondary btn-block" id="account-settings-btn" href="/account">
          Name, email &amp; password
        </Link>
        <button className="btn-quiet btn-block" onClick={() => void authClient.signOut()}>
          Sign out
        </button>
      </div>
    </section>
  );
}
