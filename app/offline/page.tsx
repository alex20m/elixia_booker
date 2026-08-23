import Link from 'next/link';
import { Brand } from '../components/Brand';

export const metadata = { title: 'Offline · Elixia Booker' };

/**
 * What the service worker shows when a page cannot be reached.
 *
 * Precached at install, so it is the one page guaranteed to render with no
 * network. It deliberately says what is still true — the booking runs on a
 * server, not on this phone — because the fear when an app goes blank offline
 * is that it stopped doing its job.
 */
export default function OfflinePage() {
  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-inner">
          <Brand />
        </div>
      </header>
      <main className="main main-narrow">
        <div className="hero">
          <h1>You are offline</h1>
          <p className="hero-sub">
            Booker keeps running on the server — your classes are still being booked. This screen
            just needs a connection to show them.
          </p>
        </div>
        <Link className="btn btn-block" href="/">
          Try again
        </Link>
      </main>
    </div>
  );
}
