'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth/client';
import {
  apiRequest as api,
  dashboardScreen,
  describeUnlisted,
  loadDashboard,
  tabFromSearch,
  titleCase,
  type DashboardLoad,
  type TabId,
} from '@/lib/dashboardState';
import type { DashboardView } from '@/lib/service';
import { AccountCard } from './AccountCard';
import AddClass from './AddClass';
import Setup from './Setup';
import { SettingsPanel } from './SettingsPanel';
import { InstallButton, InstallCard } from './components/InstallCard';
import { Shell } from './components/Shell';
import { CalendarIcon, CheckIcon, PulseIcon, SlidersIcon } from './components/icons';
import { ThemeChoiceControl } from './components/theme';

const OUTCOME_LABELS: Record<string, [string, string]> = {
  booked: ['pill-ok', 'Booked'],
  waitlisted: ['pill-ok', 'Waitlisted'],
  'already-booked': ['pill-warn', 'Overlapping'],
  'too-early': ['pill-err', 'Missed'],
  'rate-limited': ['pill-err', 'Rate limited'],
  unauthorized: ['pill-err', 'Session rejected'],
  error: ['pill-err', 'Error'],
};

export default function DashboardApp() {
  // Re-renders on its own when the session changes — including in another tab —
  // so a signed-out session cannot leave a stale dashboard on screen.
  return <Authenticated />;
}

function Authenticated() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;
  // Tagged with the account it belongs to, and null until the first request
  // settles. Every other outcome — including failure — is a value, so nothing
  // can silently look like "still loading".
  const [load, setLoad] = useState<{ userId: string; result: DashboardLoad } | null>(null);

  // Keyed on the id, not the user object: the hook is free to hand back a new
  // object on every render, and depending on that identity would re-create
  // `refresh`, re-fire the effect, and fetch the dashboard in a loop.
  const userId = user?.id ?? null;

  // Handed to the children, which call it after every mutation.
  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoad({ userId, result: await loadDashboard() });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    // `active` guards against a slow response landing after the signed-in user
    // changed, which would otherwise show one account another's dashboard. The
    // state update lives in the continuation rather than the effect body, which
    // is also what keeps this off React's cascading-render path.
    let active = true;
    void loadDashboard().then((result) => {
      if (active) setLoad({ userId, result });
    });

    return () => {
      active = false;
    };
  }, [userId]);

  // Tagging rather than clearing on sign-out: a result belonging to a previous
  // account reads as "not loaded yet", so signing straight back in as someone
  // else cannot flash their predecessor's dashboard — and the effect stays free
  // of the synchronous setState that would cascade renders.
  const current = load && load.userId === userId ? load.result : null;

  const screen = dashboardScreen({
    sessionPending: session.isPending,
    signedIn: Boolean(user),
    load: current,
  });

  switch (screen.kind) {
    case 'loading':
      return (
        <Shell>
          <main className="main main-narrow">
            <p className="empty">Loading your account…</p>
          </main>
        </Shell>
      );
    case 'signed-out':
      return <SignedOut />;
    case 'setup':
      // The whole app, replaced by the configuration pages: there is nothing
      // behind them worth showing, and every endpoint the dashboard would call
      // answers 428 until they are finished.
      return <Setup onDone={() => void refresh()} />;
    case 'error':
      return <LoadFailed message={screen.message} retry={refresh} />;
    case 'dashboard':
      return <Dashboard view={screen.view} refresh={refresh} />;
  }
}

/**
 * The dashboard could not be loaded.
 *
 * Shows the server's own message: the ones that reach here are deliberate and
 * actionable ("ENCRYPTION_KEY is not set…"), and anything unexpected has
 * already been flattened to "Something went wrong" server-side. Sign out is
 * offered alongside retry because a session the server keeps refusing is the
 * one failure the visitor can clear themselves.
 */
function LoadFailed({ message, retry }: { message: string; retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  return (
    <Shell>
      <main className="main main-narrow">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Could not load your account</h2>
          </div>
          <div className="banner banner-err" id="load-error">
            {message}
          </div>
          <div className="cluster mt-m">
            <button
              id="retry-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await retry();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Retrying…' : 'Try again'}
            </button>
            <button className="btn-quiet" onClick={() => void authClient.signOut()}>
              Sign out
            </button>
          </div>
        </section>
      </main>
    </Shell>
  );
}

function SignedOut() {
  return (
    <Shell>
      <main className="main main-narrow">
        <div className="hero">
          <h1>Never miss a class again.</h1>
          <p className="hero-sub">
            Pick the classes you want. Booker signs in and books them the second Elixia opens
            the window — while you are asleep.
          </p>
        </div>

        <section className="card">
          <div className="stack">
            <Link className="btn btn-block" id="auth-btn" href="/auth/sign-in">
              Sign in
            </Link>
            <Link className="btn btn-secondary btn-block" id="auth-toggle" href="/auth/sign-up">
              Create an account
            </Link>
            <p className="hint">
              Your Booker account is separate from your Elixia login. You link the gym account
              after signing in.
            </p>
          </div>
        </section>

        <InstallCard />
      </main>
    </Shell>
  );
}

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'classes', label: 'Classes', icon: <CalendarIcon /> },
  { id: 'activity', label: 'Activity', icon: <PulseIcon /> },
  { id: 'settings', label: 'Settings', icon: <SlidersIcon /> },
];

function Dashboard({
  view,
  refresh,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
}) {
  // Seeded from the URL's own `?tab=` rather than always 'classes', so a
  // visitor who left Settings for /account/* and comes back lands on
  // Settings again instead of being bounced to the first tab. `selectTab`
  // keeps that query string in sync as the visitor switches tabs.
  const [tab, setTabState] = useState<TabId>(() =>
    typeof window === 'undefined' ? 'classes' : tabFromSearch(window.location.search),
  );
  const selectTab = useCallback((id: TabId) => {
    setTabState(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', id);
      // replaceState, not a router push: switching tabs is not a page the
      // back button should ever need to step back through on its own.
      window.history.replaceState(null, '', url);
    }
  }, []);
  const linked = view.account.elixiaStatus === 'ok';

  return (
    <Shell
      actions={
        <>
          <InstallButton onManual={() => selectTab('settings')} />
          <button
            className="btn-quiet btn-sm"
            id="signout-btn"
            onClick={() => void authClient.signOut()}
          >
            Sign out
          </button>
        </>
      }
    >
      {/* One control in two places: a thumb-reachable bar at the bottom of a
          phone, a row of pills under the header on a desktop. */}
      <nav className="tabs" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tab"
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => selectTab(entry.id)}
          >
            {entry.icon}
            <span>{entry.label}</span>
          </button>
        ))}
      </nav>

      <main className="main">
        <DeploymentAlerts view={view} />

        {tab === 'classes' && <ClassesTab view={view} refresh={refresh} linked={linked} />}
        {tab === 'activity' && <ActivityTab view={view} />}
        {tab === 'settings' && <SettingsTab view={view} refresh={refresh} linked={linked} />}
      </main>
    </Shell>
  );
}

/**
 * Warnings about the deployment rather than the account — shown on every tab
 * because each one means bookings are not happening the way the rest of the
 * screen implies, and none of them is the visitor's fault.
 */
function DeploymentAlerts({ view }: { view: DashboardView }) {
  return (
    <>
      {view.ephemeralStore && (
        <div className="banner banner-err">
          <span>
            No database configured — data is in memory and will not survive. Set{' '}
            <code>DATABASE_URL</code>.
          </span>
        </div>
      )}
      {view.dryRun && (
        <div className="banner banner-warn">
          <span>Dry-run mode: everything runs except the final booking request.</span>
        </div>
      )}
      {!view.apiDiscovered && (
        <div className="banner banner-err">
          <span>
            The Elixia API adapter has not been configured yet, so no real booking can be made.
            See <code>docs/api.md</code>.
          </span>
        </div>
      )}
    </>
  );
}

function ClassesTab({
  view,
  refresh,
  linked,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
  linked: boolean;
}) {
  if (!linked) {
    return <ElixiaLink view={view} refresh={refresh} />;
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Your classes</h2>
          <span className="pill pill-neutral">{view.subscriptions.length}</span>
        </div>
        <ClassList view={view} refresh={refresh} />
      </section>
      <AddClass refresh={refresh} />
    </>
  );
}

function SettingsTab({
  view,
  refresh,
  linked,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
  linked: boolean;
}) {
  return (
    <>
      {linked && <ElixiaLink view={view} refresh={refresh} />}

      <SettingsPanel view={view} refresh={refresh} />

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Appearance</h2>
        </div>
        <ThemeChoiceControl />
        <p className="hint mt-s">
          Auto follows your phone or computer’s own light and dark setting.
        </p>
      </section>

      <InstallCard />

      <AccountCard />

      <p className="foot">Books only your own account. Retries are bounded and rate-limit aware.</p>
    </>
  );
}

function ElixiaLink({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (view.account.elixiaStatus === 'ok') {
    return (
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Gym account</h2>
          <span className="pill pill-ok">
            <CheckIcon size={13} /> Connected
          </span>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title" id="account-line">
              {view.account.elixiaEmail}
            </div>
            <div className="row-meta">Credentials stored encrypted</div>
          </div>
          <div className="row-actions">
            <button
              className="btn-danger btn-sm"
              id="unlink-btn"
              onClick={async () => {
                await api('/api/elixia', { method: 'DELETE' });
                await refresh();
              }}
            >
              Unlink
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Link your Elixia account</h2>
          <p className="card-sub">Booker needs it to reserve classes on your behalf.</p>
        </div>
      </div>

      {view.account.elixiaStatus === 'expired' && (
        <div className="banner banner-warn mt-m">
          <span>
            Elixia rejected the saved credentials, so booking is paused. Re-link to resume.
          </span>
        </div>
      )}
      {error && (
        <div className="banner banner-err mt-m">
          <span>{error}</span>
        </div>
      )}

      <div className="grid-2">
        <div className="field">
          <label htmlFor="ex-email">Elixia email</label>
          <input
            id="ex-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ex-password">Elixia password</label>
          <input
            id="ex-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <button
        id="link-btn"
        className="btn-block mt-m"
        disabled={busy}
        onClick={async () => {
          setError('');
          setBusy(true);
          try {
            await api('/api/elixia', {
              method: 'POST',
              body: JSON.stringify({ email, password }),
            });
            setPassword('');
            await refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Checking…' : 'Link account'}
      </button>

      <p className="hint mt-s">
        Your Elixia password is stored <strong>encrypted</strong>, because the bot has to
        re-authenticate on its own when a session expires — otherwise booking would stop silently
        until you noticed. Unlinking erases it.
      </p>
    </section>
  );
}

function ClassList({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  if (view.subscriptions.length === 0) {
    return <p className="empty">No classes yet. Add your first one below.</p>;
  }

  return (
    <div className="list" id="subs-list">
      {view.subscriptions.map((s) => {
        const unlisted = describeUnlisted(s.unlistedSinceMs);

        return (
          <div className={`row${s.enabled ? '' : ' is-paused'}`} key={s.id}>
            <div className="row-main">
              <div className="row-title">{s.className}</div>
              <div className="row-meta">
                {s.center} · {titleCase(s.weekday)} {s.startTime}
              </div>
              <div className="row-meta">
                {s.enabled
                  ? s.nextReleaseAt
                    ? `Opens ${new Date(s.nextReleaseAt).toLocaleString()}`
                    : 'No upcoming release'
                  : 'Paused'}
              </div>
              {unlisted && (
                <div className="banner banner-warn mt-xs">
                  <span>{unlisted}</span>
                </div>
              )}
            </div>
            <div className="row-actions">
              <button
                className="btn-quiet btn-sm"
                onClick={async () => {
                  await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'PATCH' });
                  await refresh();
                }}
              >
                {s.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                className="btn-danger btn-sm"
                onClick={async () => {
                  await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                  await refresh();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityTab({ view }: { view: DashboardView }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Recent attempts</h2>
      </div>
      {view.history.length === 0 ? (
        <p className="empty">Nothing yet. Attempts appear here after a booking window opens.</p>
      ) : (
        <div className="list" id="history-list">
          {view.history.map((h, i) => {
            const [cls, label] = OUTCOME_LABELS[h.outcome] ?? ['pill-err', h.outcome];
            const timing =
              h.firstAttemptOffsetMs === null
                ? ''
                : ` · fired ${h.firstAttemptOffsetMs >= 0 ? '+' : ''}${h.firstAttemptOffsetMs}ms from T-0`;
            return (
              <div className="row" key={`${h.subscriptionId ?? 'gone'}-${h.atMs}-${i}`}>
                <div className="row-main">
                  <div className="row-title">
                    {h.className} · {h.classDate} {h.startTime}
                  </div>
                  <div className="row-meta">
                    {new Date(h.atMs).toLocaleString()}
                    {h.dryRun ? ' · dry run' : ''}
                    {timing}
                    {h.detail ? ` · ${h.detail}` : ''}
                  </div>
                </div>
                <span className={`pill ${cls}`}>{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
