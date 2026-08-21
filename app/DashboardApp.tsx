'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth/client';
import {
  apiRequest as api,
  dashboardScreen,
  loadDashboard,
  type DashboardLoad,
} from '@/lib/dashboardState';
import type { DashboardView } from '@/lib/service';
import type { Weekday } from '@/lib/types';

const WEEKDAY_OPTIONS: Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const OUTCOME_LABELS: Record<string, [string, string]> = {
  booked: ['pill-ok', 'Booked'],
  waitlisted: ['pill-ok', 'Waitlisted'],
  'already-booked': ['pill-warn', 'Overlapping'],
  'too-early': ['pill-err', 'Missed'],
  'rate-limited': ['pill-err', 'Rate limited'],
  unauthorized: ['pill-err', 'Session rejected'],
  error: ['pill-err', 'Error'],
};

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
      return <p className="sub">Loading your account…</p>;
    case 'signed-out':
      return <AuthPanel />;
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
    <>
      <h1>Elixia Booker</h1>
      <div className="card">
        <h2>Could not load your account</h2>
        <div className="banner banner-err" id="load-error">
          {message}
        </div>
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
        </button>{' '}
        <button className="ghost" onClick={() => void authClient.signOut()}>
          Sign out
        </button>
      </div>
    </>
  );
}

function AuthPanel() {
  return (
    <>
      <h1>Elixia Booker</h1>
      <p className="sub">Books your group fitness classes the moment booking opens.</p>
      <div className="card">
        <h2>Sign in</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Your Booker account is separate from your Elixia login. You link the gym account
          after signing in.
        </p>
        <Link className="btn" id="auth-btn" href="/auth/sign-in">
          Sign in
        </Link>{' '}
        <Link className="btn ghost" id="auth-toggle" href="/auth/sign-up">
          Create an account
        </Link>
      </div>
    </>
  );
}

function Dashboard({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  const linked = view.account.elixiaStatus === 'ok';

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Elixia Booker</h1>
          <p className="sub" id="account-line">
            {view.account.elixiaEmail || 'No gym account linked'}
          </p>
        </div>
        <div>
          {/* Password changes, email addresses and account deletion all live in
              Neon Auth's own settings page rather than being reimplemented. */}
          <Link className="btn ghost" id="account-btn" href="/account/settings">
            Account
          </Link>{' '}
          <button className="ghost" id="signout-btn" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </div>
      </div>

      {view.ephemeralStore && (
        <div className="banner banner-err">
          No database configured — data is in memory and will not survive. See{' '}
          <code>SETUP.md</code>.
        </div>
      )}
      {view.dryRun && (
        <div className="banner banner-warn">
          Dry-run mode: everything runs except the final booking request.
        </div>
      )}
      {!view.apiDiscovered && (
        <div className="banner banner-err">
          The Elixia API adapter has not been configured yet, so no real booking can be made.
          See <code>docs/api.md</code>.
        </div>
      )}

      <ElixiaLink view={view} refresh={refresh} />

      {linked && (
        <>
          <div className="card">
            <h2>Your classes</h2>
            <ClassList view={view} refresh={refresh} />
          </div>
          <AddClass refresh={refresh} />
        </>
      )}

      <Settings view={view} refresh={refresh} />

      <div className="card">
        <h2>Recent attempts</h2>
        <History view={view} />
      </div>

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
      <div className="card">
        <h2>Gym account</h2>
        <div className="item">
          <div className="item-main">
            <div className="item-title">{view.account.elixiaEmail}</div>
            <div className="item-meta">Linked · credentials stored encrypted</div>
          </div>
          <span className="pill pill-ok">Connected</span>
          <button
            className="ghost"
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
    );
  }

  return (
    <div className="card">
      <h2>Link your Elixia account</h2>
      {view.account.elixiaStatus === 'expired' && (
        <div className="banner banner-warn">
          Elixia rejected the saved credentials, so booking is paused. Re-link to resume.
        </div>
      )}
      {error && <div className="banner banner-err">{error}</div>}
      <div className="row row-2">
        <div>
          <label htmlFor="ex-email">Elixia email</label>
          <input
            id="ex-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="ex-password">Elixia password</label>
          <input
            id="ex-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      <button
        id="link-btn"
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
      <p className="sub" style={{ margin: '14px 0 0', fontSize: 13 }}>
        Your Elixia password is stored <strong>encrypted</strong>, because the bot has to
        re-authenticate on its own when a session expires — otherwise booking would stop
        silently until you noticed. Unlinking erases it.
      </p>
    </div>
  );
}

function ClassList({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  if (view.subscriptions.length === 0) {
    return <p className="empty">No classes yet. Add one below.</p>;
  }

  return (
    <div id="subs-list">
      {view.subscriptions.map((s) => (
        <div className={`item${s.enabled ? '' : ' paused'}`} key={s.id}>
          <div className="item-main">
            <div className="item-title">{s.className}</div>
            <div className="item-meta">
              {s.center} · {titleCase(s.weekday)} {s.startTime}
            </div>
            <div className="item-meta">
              {s.enabled
                ? s.nextReleaseAt
                  ? `Opens ${new Date(s.nextReleaseAt).toLocaleString()}`
                  : 'No upcoming release'
                : 'Paused'}
            </div>
          </div>
          <button
            className="ghost"
            onClick={async () => {
              await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'PATCH' });
              await refresh();
            }}
          >
            {s.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            className="ghost"
            onClick={async () => {
              await api(`/api/subscriptions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
              await refresh();
            }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function AddClass({ refresh }: { refresh: () => Promise<void> }) {
  const [className, setClassName] = useState('');
  const [center, setCenter] = useState('');
  const [weekday, setWeekday] = useState<Weekday>('monday');
  const [startTime, setStartTime] = useState('09:00');
  const [error, setError] = useState('');

  return (
    <div className="card">
      <h2>Add a class</h2>
      <div className="row row-2">
        <div>
          <label htmlFor="s-name">Class name</label>
          <input
            id="s-name"
            placeholder="Bodypump"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="s-center">Centre</label>
          <input
            id="s-center"
            placeholder="Tapiola"
            value={center}
            onChange={(e) => setCenter(e.target.value)}
          />
        </div>
      </div>
      <div className="row row-3">
        <div>
          <label htmlFor="s-weekday">Weekday</label>
          <select
            id="s-weekday"
            value={weekday}
            onChange={(e) => setWeekday(e.target.value as Weekday)}
          >
            {WEEKDAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {titleCase(d)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="s-time">Start time</label>
          <input
            id="s-time"
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </div>
      </div>
      {error && <div className="banner banner-err">{error}</div>}
      <button
        id="add-btn"
        onClick={async () => {
          setError('');
          try {
            await api('/api/subscriptions', {
              method: 'POST',
              body: JSON.stringify({ className, center, weekday, startTime }),
            });
            setClassName('');
            setCenter('');
            await refresh();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Add class
      </button>
    </div>
  );
}

function Settings({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  const [windowDays, setWindowDays] = useState(String(view.account.bookingWindowDays));
  const [timeZone, setTimeZone] = useState(view.account.timeZone);
  const [chatId, setChatId] = useState(view.account.telegramChatId);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <div className="card">
      <h2>Settings</h2>
      <div className="row row-2">
        <div>
          <label htmlFor="tier">Membership</label>
          <select id="tier" value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
            <option value="7">Basic / Flexible — 7 days</option>
            <option value="14">Premium — 14 days</option>
          </select>
        </div>
        <div>
          <label htmlFor="tz">Timezone</label>
          <input id="tz" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div>
          <label htmlFor="tg">Telegram chat ID (optional)</label>
          <input
            id="tg"
            placeholder="Leave blank for no notifications"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
        </div>
      </div>
      {error && <div className="banner banner-err">{error}</div>}
      <button
        id="save-btn"
        onClick={async () => {
          setError('');
          setSaved(false);
          try {
            await api('/api/settings', {
              method: 'PUT',
              body: JSON.stringify({
                bookingWindowDays: Number(windowDays),
                timeZone,
                telegramChatId: chatId,
              }),
            });
            setSaved(true);
            await refresh();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        {saved ? 'Saved' : 'Save settings'}
      </button>
    </div>
  );
}

function History({ view }: { view: DashboardView }) {
  if (view.history.length === 0) {
    return <p className="empty">Nothing yet. Attempts appear here after a booking window opens.</p>;
  }

  return (
    <div id="history-list">
      {view.history.map((h, i) => {
        const [cls, label] = OUTCOME_LABELS[h.outcome] ?? ['pill-err', h.outcome];
        const timing =
          h.firstAttemptOffsetMs === null
            ? ''
            : ` · fired ${h.firstAttemptOffsetMs >= 0 ? '+' : ''}${h.firstAttemptOffsetMs}ms from T-0`;
        return (
          <div className="item" key={`${h.subscriptionId ?? 'gone'}-${h.atMs}-${i}`}>
            <div className="item-main">
              <div className="item-title">
                {h.className} · {h.classDate} {h.startTime}
              </div>
              <div className="item-meta">
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
  );
}
