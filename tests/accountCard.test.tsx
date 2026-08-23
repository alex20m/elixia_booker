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
 * The Account card, linking out to Neon Auth's own account page for name,
 * email and password.
 *
 * This used to offer two separate links — one into a "Security" tab for the
 * password field, one into an "Account" tab for email — because those lived
 * on separate pages switched between by a sidebar nav that collapsed into a
 * hamburger drawer on phones and never opened. The two pages were combined
 * into one (see app/account/page.tsx), so a single link now covers both.
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
  it('sends the account link to the combined name/email/password page', () => {
    render();

    const link = byId<HTMLAnchorElement>('account-settings-btn');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/account');
    expect(link!.textContent).toMatch(/password/i);
  });

  it('offers only one account link, not a separate one per section', () => {
    render();

    expect(container.querySelectorAll('a').length).toBe(1);
  });

  it('signs out through the auth client', async () => {
    render();

    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
