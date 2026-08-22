import { authConfigured } from '@/lib/auth/neonAuth';
import DashboardApp from './DashboardApp';

export const dynamic = 'force-dynamic';

export default function Page() {
  if (!authConfigured()) {
    return (
      <>
        <h1>Elixia Booker</h1>
        <div className="banner banner-err">
          Neon Auth is not configured. Set <code>NEON_AUTH_BASE_URL</code> and{' '}
          <code>NEON_AUTH_COOKIE_SECRET</code>, then reload.
        </div>
      </>
    );
  }

  return <DashboardApp />;
}
