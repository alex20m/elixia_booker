'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth/client';
import {
  apiRequest as api,
  classStatus,
  dashboardScreen,
  describeUnavailable,
  describeUnlisted,
  formatClassDate,
  loadDashboard,
  tabFromSearch,
  type DashboardLoad,
  type TabId,
} from '@/lib/dashboardState';
import type { DashboardView } from '@/lib/service';
import { AccountCard } from './AccountCard';
import { ElixiaLink } from './ElixiaLink';
import AddClass from './AddClass';
import Setup from './Setup';
import { SettingsPanel } from './SettingsPanel';
import { ActionButton } from './components/ActionButton';
import { InstallButton, InstallCard } from './components/InstallCard';
import { BusyBar, LoadingScreen, SkeletonCard, SkeletonList } from './components/Loading';
import { NavMenu, type NavSection } from './components/NavMenu';
import { Shell } from './components/Shell';
import { SignOutButton } from './components/SignOutButton';
import { CalendarIcon, PauseIcon, PlayIcon, PulseIcon, SlidersIcon, TrashIcon } from './components/icons';
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

  // A refresh is a wait the visitor is already looking at the result of, so it
  // is tracked separately from the first load: the dashboard stays on screen
  // and a bar under the header says newer data is on its way. Blanking a filled
  // page back to skeletons after every pause or remove reads as the app having
  // lost what it just showed.
  const [refreshing, setRefreshing] = useState(false);

  // Handed to the children, which call it after every mutation.
  const refresh = useCallback(async () => {
    if (!userId) return;
    setRefreshing(true);
    try {
      setLoad({ userId, result: await loadDashboard() });
    } finally {
      setRefreshing(false);
    }
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
      // Shaped like the dashboard it is about to become — a list of classes and
      // a card under it — so the page does not rearrange itself the moment the
      // data lands.
      return (
        <LoadingScreen label="Loading your account…">
          <SkeletonList rows={3} />
          <SkeletonCard lines={2} />
        </LoadingScreen>
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
      return <Dashboard view={screen.view} refresh={refresh} refreshing={refreshing} />;
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
            <ActionButton id="retry-btn" pendingLabel="Retrying…" onClick={retry}>
              Try again
            </ActionButton>
            <SignOutButton className="btn-quiet" />
          </div>
        </section>
      </main>
    </Shell>
  );
}

/**
 * The first screen anyone who is not signed in sees.
 *
 * It carries one sentence about what the app does and the two doors into it,
 * and nothing else. The install offer used to sit under them, and on a phone
 * it was the taller half of the page — a numbered how-to for a home-screen
 * icon, addressed to someone who has not yet decided to have an account.
 * Installing is worth offering *after* there is something to install for, so
 * it lives in Settings and in the last step of setup, where the same
 * `InstallCard` is shown to someone who has somewhere to go back to. The note
 * about the Elixia login moved to the sign-in and sign-up pages, which is
 * where a password is actually being typed.
 */
export function SignedOut() {
  return (
    <Shell>
      <main className="main main-narrow">
        <div className="hero">
          <h1>Never miss a class again.</h1>
          <p className="hero-sub">
            Pick the classes you want. Booker books them the second Elixia opens the window —
            while you are asleep.
          </p>
        </div>

        {/* No card around them: a panel drawn around two full-width buttons
            and nothing else is a border for its own sake. */}
        <div className="stack">
          <Link className="btn btn-block" id="auth-btn" href="/auth/sign-in">
            Sign in
          </Link>
          <Link className="btn btn-secondary btn-block" id="auth-toggle" href="/auth/sign-up">
            Create an account
          </Link>
        </div>
      </main>
    </Shell>
  );
}

const SECTIONS: Array<NavSection<TabId>> = [
  { id: 'classes', label: 'Classes', icon: <CalendarIcon /> },
  { id: 'activity', label: 'Activity', icon: <PulseIcon /> },
  { id: 'settings', label: 'Settings', icon: <SlidersIcon /> },
];

function Dashboard({
  view,
  refresh,
  refreshing,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
  /** A reload of what is already on screen is in flight. */
  refreshing: boolean;
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
          <InstallButton />
          <NavMenu sections={SECTIONS} current={tab} onSelect={selectTab} />
        </>
      }
    >
      <BusyBar busy={refreshing} label="Refreshing your classes…" />

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
          <h2 className="card-title">Upcoming bookings</h2>
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

function ClassList({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  if (view.subscriptions.length === 0) {
    return <p className="empty">No classes yet. Add your first one below.</p>;
  }

  return (
    <div className="list" id="subs-list">
      {view.subscriptions.map((s) => {
        const unlisted = describeUnlisted(s.unlistedSinceMs);
        // Superseded by `unlisted` when both apply: a class Elixia has
        // withdrawn altogether is the more serious fact, and showing both
        // would say the same thing about the same date twice.
        const unavailable = unlisted ? null : describeUnavailable(s.nextClassDate, s.unavailableClassDate);
        const status = classStatus({
          enabled: s.enabled,
          notFound: Boolean(unlisted) || Boolean(unavailable),
          nextReleaseAt: s.nextReleaseAt,
        });

        return (
          <div
            className={`row${s.enabled ? '' : ' is-paused'}${unavailable ? ' is-unavailable' : ''}`}
            key={s.id}
          >
            <div className="row-main">
              {s.nextClassDate && <div className="class-day">{formatClassDate(s.nextClassDate)}</div>}
              <div className="class-body-row">
                <div className={`class-bar${status.emphasize ? '' : ' is-muted'}`} />
                <div className="class-time">{s.startTime}</div>
                <div className="class-details">
                  <div className="class-name">{s.className}</div>
                  {s.instructorName && <div className="class-instructor">with {s.instructorName}</div>}
                  <div className="class-location">{s.center}</div>
                  <div className={status.emphasize ? 'class-status is-open' : 'class-status'}>
                    {status.text}
                  </div>
                </div>
              </div>
              {unlisted && (
                <div className="banner banner-warn mt-xs">
                  <span>{unlisted}</span>
                </div>
              )}
              {unavailable && (
                <div className="banner banner-info mt-xs">
                  <span>{unavailable}</span>
                </div>
              )}
            </div>
            <div className="row-actions">
              <ActionButton
                id={`pause-${s.id}`}
                className="btn-quiet btn-sm row-action-btn"
                pendingLabel="…"
                aria-label={s.enabled ? 'Pause' : 'Resume'}
                onClick={async () => {
                  await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'PATCH' });
                  await refresh();
                }}
              >
                {s.enabled ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
                <span className="btn-label">{s.enabled ? 'Pause' : 'Resume'}</span>
              </ActionButton>
              <ActionButton
                id={`remove-${s.id}`}
                className="btn-danger btn-sm row-action-btn"
                pendingLabel="…"
                aria-label="Remove"
                onClick={async () => {
                  await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                  await refresh();
                }}
              >
                <TrashIcon size={22} />
                <span className="btn-label">Remove</span>
              </ActionButton>
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
