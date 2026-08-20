'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth/client';
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
  'already-booked': ['pill-ok', 'Already booked'],
  full: ['pill-warn', 'Full'],
  'too-early': ['pill-err', 'Missed'],
  'rate-limited': ['pill-err', 'Rate limited'],
  unauthorized: ['pill-err', 'Session rejected'],
  error: ['pill-err', 'Error'],
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body as T;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The dashboard, or null if it could not be loaded (signed out, server down). */
async function loadDashboard(): Promise<DashboardView | null> {
  try {
    return await api<DashboardView>('/api/me');
  } catch {
    return null;
  }
}

export default function DashboardApp() {
  // Re-renders on its own when the session changes — including in another tab —
  // so a signed-out session cannot leave a stale dashboard on screen.
  return <Authenticated />;
}

function Authenticated() {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;
  const [view, setView] = useState<DashboardView | null>(null);
  const [loading, setLoading] = useState(true);

  // Keyed on the id, not the user object: the hook is free to hand back a new
  // object on every render, and depending on that identity would re-create
  // `refresh`, re-fire the effect, and fetch the dashboard in a loop.
  const userId = user?.id ?? null;

  // Handed to the children, which call it after every mutation.
  const refresh = useCallback(async () => {
    setView(await loadDashboard());
  }, []);

  useEffect(() => {
    if (!userId) return;

    // `active` guards against a slow response landing after the signed-in user
    // changed, which would otherwise show one account another's dashboard. The
    // state updates live in the continuation rather than the effect body, which
    // is also what keeps this off React's cascading-render path.
    let active = true;
    void loadDashboard().then((next) => {
      if (!active) return;
      setView(next);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [userId]);

  if (session.isPending) return <p className="sub">Loading…</p>;
  if (!user) return <AuthPanel />;
  if (loading) return <p className="sub">Loading…</p>;
  if (!view) return <p className="sub">Loading your account…</p>;

  return <Dashboard view={view} refresh={refresh} />;
}

/**
 * The sign-in invitation.
 *
 * The forms themselves live at /auth/*, served by Neon Auth, which is what
 * makes email verification and password reset work at all — there is no mail
 * sender in this app to hand-roll them with.
 */
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
              {s.center} · {titleCase(s.weekday)} {s.startTime} ·{' '}
              {s.onFull === 'waitlist' ? 'waitlist if full' : 'skip if full'}
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
  const [onFull, setOnFull] = useState('waitlist');
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
        <div>
          <label htmlFor="s-full">If full</label>
          <select id="s-full" value={onFull} onChange={(e) => setOnFull(e.target.value)}>
            <option value="waitlist">Join waitlist</option>
            <option value="skip">Skip</option>
          </select>
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
              body: JSON.stringify({ className, center, weekday, startTime, onFull }),
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
