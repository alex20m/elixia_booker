// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const signOut = vi.fn();

vi.mock('@/lib/auth/client', () => ({
  authClient: { signOut: (...args: unknown[]) => signOut(...args) },
}));

const { SignOutButton } = await import('@/app/components/SignOutButton');

/**
 * Signing out, behind a confirmation.
 *
 * The control used to fire the sign-out request straight from the click —
 * these tests exist because that made a miss-tap indistinguishable from an
 * intentional sign-out. What is worth pinning: the request never fires until
 * a second, separate press confirms it; every way of backing out (Cancel,
 * Escape, the backdrop) leaves the session untouched; and none of those ways
 * out do anything once the confirmed request is already on the wire, since a
 * "cancel" that let it finish anyway would still sign the visitor out.
 */

let container: HTMLDivElement;
let root: Root;

/** A promise a test finishes by hand, so the in-flight state can be inspected. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

const render = (): void => {
  act(() => {
    root.render(<SignOutButton id="signout-btn" />);
  });
};

const click = async (el: Element | null): Promise<void> => {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const press = async (key: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

const open = async (): Promise<void> => click(byId('signout-btn'));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  signOut.mockClear();
  signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SignOutButton', () => {
  it('does not sign out on the first press, only opens the confirmation', async () => {
    render();
    await open();

    expect(signOut).not.toHaveBeenCalled();
    expect(byId('signout-confirm-dialog')).not.toBeNull();
    expect(byId('signout-confirm-btn')).not.toBeNull();
  });

  it('signs out only once the dialog is confirmed', async () => {
    render();
    await open();
    await click(byId('signout-confirm-btn'));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('leaves the session untouched when Cancel is pressed', async () => {
    render();
    await open();
    await click(byId('signout-confirm-cancel-btn'));

    expect(signOut).not.toHaveBeenCalled();
    expect(byId('signout-confirm-dialog')).toBeNull();
  });

  it('hands focus back to the trigger when Cancel is pressed', async () => {
    render();
    await open();
    await click(byId('signout-confirm-cancel-btn'));

    expect(document.activeElement).toBe(byId('signout-btn'));
  });

  it('leaves the session untouched when the backdrop is tapped', async () => {
    render();
    await open();
    await click(container.querySelector('.signout-confirm-backdrop'));

    expect(signOut).not.toHaveBeenCalled();
    expect(byId('signout-confirm-dialog')).toBeNull();
  });

  it('leaves the session untouched on Escape', async () => {
    render();
    await open();
    await press('Escape');

    expect(signOut).not.toHaveBeenCalled();
    expect(byId('signout-confirm-dialog')).toBeNull();
  });

  it('sends one sign-out request for a double-tapped confirm', async () => {
    const held = deferred();
    signOut.mockReturnValue(held.promise);
    render();
    await open();

    await act(async () => {
      byId<HTMLButtonElement>('signout-confirm-btn')!.click();
      byId<HTMLButtonElement>('signout-confirm-btn')!.click();
    });

    expect(signOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.resolve();
      await held.promise;
    });
  });

  it('ignores Cancel, Escape and the backdrop while the request is in flight', async () => {
    // A "cancel" that let an in-flight request finish anyway would still sign
    // the visitor out a moment after they thought they had backed out.
    const held = deferred();
    signOut.mockReturnValue(held.promise);
    render();
    await open();
    await click(byId('signout-confirm-btn'));

    expect(byId<HTMLButtonElement>('signout-confirm-cancel-btn')!.disabled).toBe(true);

    await click(byId('signout-confirm-cancel-btn'));
    await press('Escape');
    await click(container.querySelector('.signout-confirm-backdrop'));

    expect(byId('signout-confirm-dialog')).not.toBeNull();

    await act(async () => {
      held.resolve();
      await held.promise;
    });

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('says it is signing out while the request is in flight', async () => {
    const held = deferred();
    signOut.mockReturnValue(held.promise);
    render();
    await open();
    await click(byId('signout-confirm-btn'));

    expect(byId('signout-confirm-btn')!.textContent).toContain('Signing out…');

    await act(async () => {
      held.resolve();
      await held.promise;
    });
  });
});
