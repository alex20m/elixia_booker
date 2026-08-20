import { AuthView } from '@neondatabase/auth-ui';
import { authViewPaths } from '@neondatabase/auth-ui/server';

/**
 * Every Neon Auth page — sign in, sign up, email verification, forgotten
 * password — served under /auth/*.
 *
 * These flows are the reason identity is not hand-rolled here. A password
 * reset that works needs an email sender, single-use tokens and rate
 * limiting; this file is what buying them costs.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export default async function AuthPage({ params }: { params: Promise<{ path: string }> }) {
  const { path } = await params;

  return (
    <main style={{ maxWidth: 420, margin: '48px auto' }}>
      <AuthView path={path} redirectTo="/" />
    </main>
  );
}
