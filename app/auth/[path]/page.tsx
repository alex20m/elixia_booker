import { AuthView } from '@neondatabase/auth-ui';
import { authViewPaths } from '@neondatabase/auth-ui/server';
import { Brand } from '../../components/Brand';

/**
 * Every Neon Auth page — sign in, sign up, email verification, forgotten
 * password — served under /auth/*.
 *
 * These flows are the reason identity is not hand-rolled here. A password
 * reset that works needs an email sender, single-use tokens and rate
 * limiting; this file is what buying them costs.
 *
 * The frame around it is ours, so arriving at sign-in does not feel like being
 * handed off to a different product: the same bar, the same column width, and
 * the same palette — Neon's components read their colours from the tokens in
 * globals.css.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export default async function AuthPage({ params }: { params: Promise<{ path: string }> }) {
  const { path } = await params;

  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-inner">
          <Brand />
        </div>
      </header>
      <main className="main main-narrow">
        <AuthView path={path} redirectTo="/" />
      </main>
    </div>
  );
}
