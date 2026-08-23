// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const signOut = vi.fn();

vi.mock('@/lib/auth/client', () => ({
  authClient: { signOut: () => signOut() },
}));

const { AccountCard } = await import('@/app/AccountCard');

/**
 * The Account card, linking out to Neon Auth's own pages for password, email
 * and sign-in.
 *
 * Regression coverage for a real bug: this card used to offer a single link
 * into Neon Auth's "Account" tab, which holds display name and connected
 * sign-in methods but not the password field — that lives on a separate
 * "Security" tab, reachable only via a sidebar nav item (a hamburger drawer
 * on phones) nothing here pointed at. A visitor looking for "change
 * password" had no way to know it existed. Pinning the two links by href is
 * what keeps that fixed.
 */

let container: HTMLDivElement;
let root: Root;

const render = (): void => {
  act(() => {
    root.render(<AccountCard />);
  });
};

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  signOut.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('AccountCard', () => {
  it('sends "change password" straight to the security tab, not the profile one', () => {
    render();

    const link = byId<HTMLAnchorElement>('account-password-btn');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/account/security');
    expect(link!.textContent).toMatch(/change password/i);
  });

  it('keeps a separate link for email and sign-in details', () => {
    render();

    const link = byId<HTMLAnchorElement>('account-settings-btn');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/account/settings');
  });

  it('signs out through the auth client', async () => {
    render();

    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
