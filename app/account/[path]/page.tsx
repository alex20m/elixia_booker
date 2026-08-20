import { AccountView } from '@neondatabase/auth-ui';
import { accountViewPaths } from '@neondatabase/auth-ui/server';

/**
 * Account settings — password changes, email addresses, account deletion —
 * served under /account/*, for the same buy-not-build reason as /auth/*.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(accountViewPaths).map((path) => ({ path }));
}

export default async function AccountPage({ params }: { params: Promise<{ path: string }> }) {
  const { path } = await params;

  return (
    <main style={{ maxWidth: 640, margin: '48px auto' }}>
      <AccountView path={path} />
    </main>
  );
}
