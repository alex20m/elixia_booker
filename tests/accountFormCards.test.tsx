// @vitest-environment jsdom
import { createContext } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cards on /account — name, email, password, and delete account.
 *
 * DeleteAccountCard is the one that matters here: it is the only entry point
 * in the whole app for a user to ask to delete their account, and
 * app/api/auth/[...path]/route.ts only ever purges the app's own data because
 * that card's dialog is what triggers Better Auth's delete-user request in
 * the first place. A page that renders name/email/password but not this card
 * would build and look complete while quietly removing the feature — which is
 * exactly what happened once, with nothing here to catch it.
 */

const AuthUIContext = createContext<{ account?: boolean }>({});

vi.mock('@neondatabase/auth-ui', () => ({
  AuthUIContext,
  useAuthenticate: vi.fn(),
  UpdateNameCard: () => <div data-testid="card-name" />,
  ChangeEmailCard: () => <div data-testid="card-email" />,
  ChangePasswordCard: () => <div data-testid="card-password" />,
  DeleteAccountCard: () => <div data-testid="card-delete-account" />,
}));

const { AccountFormCards } = await import('@/app/account/AccountFormCards');

let container: HTMLDivElement;
let root: Root;

const renderWithin = (account: boolean): void => {
  act(() => {
    root.render(
      <AuthUIContext.Provider value={{ account }}>
        <AccountFormCards />
      </AuthUIContext.Provider>,
    );
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('AccountFormCards', () => {
  it('renders the delete-account card alongside name, email and password', () => {
    renderWithin(true);

    expect(container.querySelector('[data-testid="card-name"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="card-email"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="card-password"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="card-delete-account"]')).not.toBeNull();
  });

  it('renders nothing before the auth context is ready, rather than crashing', () => {
    renderWithin(false);

    expect(container.innerHTML).toBe('');
  });
});
