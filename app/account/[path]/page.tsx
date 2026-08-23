import { AccountView } from '@neondatabase/auth-ui';
import { accountViewPaths } from '@neondatabase/auth-ui/server';
import { Brand } from '../../components/Brand';
import { BackButton } from '../../components/BackButton';

/**
 * Account settings — password changes, email addresses, account deletion —
 * served under /account/*, for the same buy-not-build reason as /auth/*.
 *
 * There is no separate "security" section in this app: everything that would
 * be in one is here, on Neon's own page, and the app's settings tab links
 * straight to it. Two places to change a password is one place too many.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(accountViewPaths).map((path) => ({ path }));
}

export default async function AccountPage({ params }: { params: Promise<{ path: string }> }) {
  const { path } = await params;

  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-inner">
          <Brand />
          <BackButton />
        </div>
      </header>
      <main className="main main-narrow account-shell">
        <AccountView path={path} />
      </main>
    </div>
  );
}
