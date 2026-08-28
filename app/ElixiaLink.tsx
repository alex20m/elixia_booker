'use client';

import { useState } from 'react';
import { apiRequest as api } from '@/lib/dashboardState';
import type { DashboardView } from '@/lib/service';
import { ActionButton } from './components/ActionButton';
import { CheckIcon } from './components/icons';

/**
 * The gym account: link one, correct the credentials of the one linked, or
 * forget it.
 *
 * Editing exists as its own operation because the obvious substitute is not
 * equivalent. Unlinking clears the queue of scheduled bookings — deliberately,
 * since the cron would otherwise keep firing against a dead link — so fixing a
 * mistyped address by unlinking and linking again quietly discarded every
 * release the planner had already worked out. `PATCH /api/elixia` keeps the
 * link and reindexes, so nothing is lost by correcting a typo.
 *
 * The password field is never prefilled, in either form. There is nothing to
 * prefill it with that would not mean sending the stored plaintext back to the
 * browser, so instead a blank one on an edit means "keep the stored password",
 * which is what lets someone change only their address without knowing it by
 * heart.
 */
export function ElixiaLink({
  view,
  refresh,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
}) {
  if (view.account.elixiaStatus === 'ok') {
    return <LinkedAccount view={view} refresh={refresh} />;
  }
  return <LinkForm view={view} refresh={refresh} />;
}

function LinkedAccount({
  view,
  refresh,
}: {
  view: DashboardView;
  refresh: () => Promise<void>;
}) {
  const linkedEmail = view.account.elixiaEmail ?? '';
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(linkedEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const open = (): void => {
    // Reset on open rather than on close, so the form a visitor returns to is
    // the stored account again and not whatever they abandoned last time.
    setEmail(linkedEmail);
    setPassword('');
    setError('');
    setEditing(true);
  };

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
            {linkedEmail}
          </div>
          <div className="row-meta">Credentials stored encrypted</div>
        </div>
        <div className="row-actions">
          <ActionButton
            className="btn-secondary btn-sm"
            id="edit-credentials-btn"
            disabled={editing}
            onClick={async () => open()}
          >
            Edit
          </ActionButton>
          <ActionButton
            className="btn-danger btn-sm"
            id="unlink-btn"
            pendingLabel="Unlinking…"
            onClick={async () => {
              await api('/api/elixia', { method: 'DELETE' });
              await refresh();
            }}
          >
            Unlink
          </ActionButton>
        </div>
      </div>

      {editing && (
        <>
          {error && (
            <div className="banner banner-err mt-m">
              <span>{error}</span>
            </div>
          )}

          <CredentialFields
            email={email}
            password={password}
            onEmail={setEmail}
            onPassword={setPassword}
            passwordLabel="New Elixia password"
            passwordAutoComplete="new-password"
          />

          <div className="cluster mt-m">
            <ActionButton
              id="save-credentials-btn"
              pendingLabel="Checking…"
              onError={(err) => setError(err.message)}
              onClick={async () => {
                setError('');
                // Both fields go every time: the server reads a blank password
                // as "keep the stored one", and sending nothing at all would
                // make an address-only edit indistinguishable from a no-op.
                await api('/api/elixia', {
                  method: 'PATCH',
                  body: JSON.stringify({ email, password }),
                });
                setPassword('');
                setEditing(false);
                await refresh();
              }}
            >
              Save changes
            </ActionButton>
            <ActionButton
              className="btn-quiet"
              id="cancel-edit-btn"
              onClick={async () => {
                setEditing(false);
                setError('');
                setPassword('');
              }}
            >
              Cancel
            </ActionButton>
          </div>

          <p className="hint mt-s">
            Elixia is asked to accept the new details before they replace the ones stored, so a
            wrong password leaves your current link working. Leave the password blank to change
            only the address.
          </p>
        </>
      )}
    </section>
  );
}

function LinkForm({ view, refresh }: { view: DashboardView; refresh: () => Promise<void> }) {
  // Seeded with the address on file, which is empty for a first link and the
  // rejected one after an expiry — where re-linking is nearly always the same
  // account with a new password, so retyping the address is pure friction.
  const [email, setEmail] = useState(view.account.elixiaEmail ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

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

      <CredentialFields
        email={email}
        password={password}
        onEmail={setEmail}
        onPassword={setPassword}
        passwordLabel="Elixia password"
        passwordAutoComplete="current-password"
      />

      <ActionButton
        id="link-btn"
        className="btn-block mt-m"
        pendingLabel="Checking…"
        onError={(err) => setError(err.message)}
        onClick={async () => {
          setError('');
          await api('/api/elixia', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          setPassword('');
          await refresh();
        }}
      >
        Link account
      </ActionButton>

      <p className="hint mt-s">
        Your Elixia password is stored <strong>encrypted</strong>, because the bot has to
        re-authenticate on its own when a session expires — otherwise booking would stop silently
        until you noticed. Unlinking erases it.
      </p>
    </section>
  );
}

/**
 * The two fields, shared by both forms so they cannot drift apart — same ids,
 * same autofill hints, and only ever one of the two forms on screen at a time.
 */
function CredentialFields({
  email,
  password,
  onEmail,
  onPassword,
  passwordLabel,
  passwordAutoComplete,
}: {
  email: string;
  password: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  passwordLabel: string;
  /** `new-password` on an edit, so a manager offers to save rather than fill. */
  passwordAutoComplete: 'current-password' | 'new-password';
}) {
  return (
    <div className="grid-2">
      <div className="field">
        <label htmlFor="ex-email">Elixia email</label>
        <input
          id="ex-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="ex-password">{passwordLabel}</label>
        <input
          id="ex-password"
          type="password"
          autoComplete={passwordAutoComplete}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
      </div>
    </div>
  );
}
