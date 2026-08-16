'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBrowserSupabase } from '@/lib/db/clients';
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

export default function Page() {
  const supabase = useMemo<SupabaseClient | null>(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return url && anonKey ? createBrowserSupabase(url, anonKey) : null;
  }, []);

  const [signedIn, setSignedIn] = useState(false);
  const [view, setView] = useState<DashboardView | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    const { data } = await supabase.auth.getSession();
    setSignedIn(Boolean(data.session));

    if (data.session) {
      try {
        setView(await api<DashboardView>('/api/me'));
      } catch {
        setView(null);
      }
    } else {
      setView(null);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void refresh();
    // Keeps the UI in step when Supabase refreshes or drops the session in
    // another tab, rather than leaving a stale dashboard on screen.
    const subscription = supabase?.auth.onAuthStateChange(() => void refresh());
    return () => subscription?.data.subscription.unsubscribe();
  }, [supabase, refresh]);

  if (!supabase) {
    return (
      <>
        <h1>Elixia Booker</h1>
        <div className="banner banner-err">
          Supabase is not configured. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, then reload. See <code>SETUP.md</code>.
        </div>
      </>
    );
  }

  if (loading) return <p className="sub">Loading…</p>;
  if (!signedIn) return <AuthPanel supabase={supabase} onSignedIn={refresh} />;
  if (!view) return <p className="sub">Loading your account…</p>;

  return <Dashboard supabase={supabase} view={view} refresh={refresh} />;
}

function AuthPanel({
  supabase,
  onSignedIn,
}: {
  supabase: SupabaseClient;
  onSignedIn: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        // With email confirmation on there is no session yet — say so, rather
        // than leaving the user staring at an unchanged form.
        if (!data.session) {
          setNotice('Check your email to confirm the account, then sign in.');
          setMode('signin');
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
      setPassword('');
      await onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Elixia Booker</h1>
      <p className="sub">Books your group fitness classes the moment booking opens.</p>
      <div className="card">
        <h2>{mode === 'signin' ? 'Sign in' : 'Create an account'}</h2>
        {error && <div className="banner banner-err">{error}</div>}
        {notice && <div className="banner banner-warn">{notice}</div>}
        <div className="row">
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <div className="row">
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>
        </div>
        <button id="auth-btn" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>{' '}
        <button
          className="ghost"
          id="auth-toggle"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError('');
            setNotice('');
          }}
        >
          {mode === 'signin' ? 'Create an account' : 'I already have an account'}
        </button>
        <p className="sub" style={{ margin: '14px 0 0', fontSize: 13 }}>
          This is your Booker account — separate from your Elixia login. You link the gym
          account after signing in.
        </p>
      </div>
    </>
  );
}

function Dashboard({
  supabase,
  view,
  refresh,
}: {
  supabase: SupabaseClient;
  view: DashboardView;
  refresh: () => Promise<void>;
}) {
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
        <button
          className="ghost"
          id="signout-btn"
          onClick={async () => {
            await supabase.auth.signOut();
            await refresh();
          }}
        >
          Sign out
        </button>
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
