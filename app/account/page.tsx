import { Brand } from '../components/Brand';
import { BackButton } from '../components/BackButton';
import { AccountFormCards } from './AccountFormCards';

/**
 * Account settings — display name, email, password — served under
 * /account, for the same buy-not-build reason as /auth/*.
 *
 * This used to be Neon's own multi-page AccountView, split across
 * /account/settings and /account/security and switched between by a sidebar
 * nav that collapsed into a hamburger drawer on phones. That drawer never
 * opened — nothing in this app's own CSS gives the drawer's portal a stacking
 * context to render into — so the two settings groups now sit on one page
 * instead of behind chrome that didn't work. The sessions list that AccountView
 * bundled into the security half is dropped: nothing here surfaces or needs it.
 */
export default function AccountPage() {
  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-inner">
          <Brand />
          <BackButton />
        </div>
      </header>
      <main className="main main-narrow account-shell">
        <AccountFormCards />
      </main>
    </div>
  );
}
