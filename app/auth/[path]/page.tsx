import { Suspense } from 'react';
import { AuthView } from '@neondatabase/auth-ui';
import { authViewPaths } from '@neondatabase/auth-ui/server';
import { Brand } from '../../components/Brand';
import { AuthNotice } from '../AuthNotice';

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

/**
 * Where an out-of-band flow comes back to.
 *
 * `/auth/callback` is Neon's own view for exactly this: it refetches the
 * session, tells the provider it changed — which refreshes the server
 * components underneath — and only then sends the visitor on to `redirectTo`.
 * Landing on `/` directly instead skips all three, which is why a verified
 * account used to arrive at a page that still believed it was signed out until
 * the visitor reloaded it by hand.
 */
const CALLBACK_PATH = '/auth/callback';

/**
 * The one thing worth saying under the form, on the two paths where a password
 * is about to be typed.
 *
 * It used to sit on the signed-out landing page, where nobody had yet been
 * asked for anything. Here it answers the question at the moment it is being
 * asked — and it is a real question, because the app's whole purpose is to log
 * in to Elixia on the visitor's behalf, which makes "the Elixia password" the
 * obvious guess at what this field wants.
 */
const CREDENTIAL_NOTES: Record<string, string> = {
  [authViewPaths.SIGN_IN]:
    'This is your Booker account, not your Elixia login. You connect the gym account after signing in.',
  [authViewPaths.SIGN_UP]:
    'This is a new Booker account, not your Elixia login — pick any email and password you like. You connect the gym account afterwards.',
};

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
        {/* Suspense because the notice reads the query string on the client;
            without it, `useSearchParams` would opt this whole page out of
            being prerendered. */}
        <Suspense fallback={null}>
          <AuthNotice />
        </Suspense>

        <AuthView path={path} redirectTo="/" callbackURL={CALLBACK_PATH} />

        {CREDENTIAL_NOTES[path] && <p className="hint">{CREDENTIAL_NOTES[path]}</p>}
      </main>
    </div>
  );
}
