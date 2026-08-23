// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const back = vi.fn();
const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, push }),
}));

const { BackButton } = await import('@/app/components/BackButton');

/**
 * The "Back" control on the account pages (/account/security,
 * /account/settings), linked out to from the Settings tab.
 *
 * Regression coverage for a real bug: this used to be a plain `<Link
 * href="/">`, which always landed on the dashboard's first tab (Classes)
 * instead of returning to Settings — the visitor had to re-navigate to
 * Settings every time they came back from changing a password. Going back
 * through browser history instead lands wherever the dashboard's own tab
 * state put the visitor before they left.
 */

let container: HTMLDivElement;
let root: Root;

const render = (): void => {
  act(() => {
    root.render(<BackButton />);
  });
};

const click = async (): Promise<void> => {
  await act(async () => {
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  back.mockClear();
  push.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('BackButton', () => {
  it('steps back through history rather than always going to the root', async () => {
    Object.defineProperty(window, 'history', {
      value: { ...window.history, length: 2 },
      configurable: true,
    });
    render();

    await click();

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('falls back to the root when there is no history to step back through', async () => {
    Object.defineProperty(window, 'history', {
      value: { ...window.history, length: 1 },
      configurable: true,
    });
    render();

    await click();

    expect(push).toHaveBeenCalledWith('/');
    expect(back).not.toHaveBeenCalled();
  });
});
