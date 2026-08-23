import { authConfigured } from '@/lib/auth/neonAuth';
import DashboardApp from './DashboardApp';
import { Brand } from './components/Brand';

export const dynamic = 'force-dynamic';

export default function Page() {
  if (!authConfigured()) {
    return (
      // No Providers here, so no theme control either — this page is the one
      // state the app can be in before it is configured, and it exists to say
      // exactly one thing.
      <div className="shell">
        <header className="appbar">
          <div className="appbar-inner">
            <Brand />
          </div>
        </header>
        <main className="main main-narrow">
          <div className="banner banner-err">
            <span>
              Neon Auth is not configured. Set <code>NEON_AUTH_BASE_URL</code> and{' '}
              <code>NEON_AUTH_COOKIE_SECRET</code>, then reload.
            </span>
          </div>
        </main>
      </div>
    );
  }

  return <DashboardApp />;
}
