// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstallPopup } from '@/app/components/InstallPopup';
import { INSTALL_POPUP_DISMISSED_KEY, INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa';

/**
 * The popup that offers to install the app to whoever is not already running
 * it from a home screen or dock.
 *
 * Unlike the card in Settings and the header button — both reachable only by
 * someone who goes looking — this one has to announce itself, because an
 * install offer nobody notices is an install that never happens. So it opens
 * on its own, and "Not now" has to bring it right back next visit: only
 * "Don't show again" is allowed to make it stop for good.
 */

let container: HTMLDivElement;
let root: Root;
let prompted: number;

const render = (): void => {
  act(() => {
    root.render(<InstallPopup />);
  });
};

const dialog = (): HTMLElement | null => container.querySelector<HTMLElement>('#install-prompt-dialog');

function parkPrompt(): void {
  (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = {
    prompt: async () => {
      prompted += 1;
    },
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  };
}

function stubBrowser({ standalone = false, userAgent = 'Mozilla/5.0 (Windows NT 10.0)' } = {}): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('display-mode'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  prompted = 0;
  (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = null;
  window.localStorage.clear();
  stubBrowser();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('InstallPopup', () => {
  it('opens on its own when there is something to install', () => {
    parkPrompt();
    render();

    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toMatch(/install elixia booker/i);
  });

  it('says nothing at all once the app is already installed', () => {
    parkPrompt();
    stubBrowser({ standalone: true });
    render();

    expect(container.textContent).toBe('');
  });

  it('stays quiet when it was told never to show again on an earlier visit', () => {
    window.localStorage.setItem(INSTALL_POPUP_DISMISSED_KEY, '1');
    parkPrompt();
    render();

    expect(dialog()).toBeNull();
  });

  it('installs directly through its own offer when the browser handed us a prompt', async () => {
    parkPrompt();
    render();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('#install-btn')!.click();
    });

    expect(prompted).toBe(1);
  });

  it('shows this platform’s manual steps when there is no prompt to replay', () => {
    stubBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    render();

    expect(dialog()!.textContent).toMatch(/add to home screen/i);
  });

  it('closes on "Not now" but comes back on the next mount', () => {
    parkPrompt();
    render();

    act(() => {
      container.querySelector<HTMLButtonElement>('#install-prompt-not-now-btn')!.click();
    });
    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(INSTALL_POPUP_DISMISSED_KEY)).toBeNull();

    // A fresh mount is the next visit — nothing was written down, so it
    // reopens exactly as before.
    act(() => root.unmount());
    root = createRoot(container);
    render();

    expect(dialog()).not.toBeNull();
  });

  it('closes on Escape the same way as "Not now" — for this visit only', () => {
    parkPrompt();
    render();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(INSTALL_POPUP_DISMISSED_KEY)).toBeNull();
  });

  it('stops for good once "Don\'t show again" is clicked', () => {
    parkPrompt();
    render();

    act(() => {
      container.querySelector<HTMLButtonElement>('#install-prompt-never-btn')!.click();
    });

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(INSTALL_POPUP_DISMISSED_KEY)).toBe('1');

    act(() => root.unmount());
    root = createRoot(container);
    render();

    expect(dialog()).toBeNull();
  });

  /**
   * The prompt commonly arrives after the first render, same as the card and
   * the header button — this popup shares their installability logic and has
   * to notice it the same way, switching from the manual steps to the direct
   * one-tap offer without needing a remount.
   */
  it('switches from manual steps to a direct install once a prompt arrives', () => {
    render();
    expect(dialog()!.textContent).toMatch(/address bar/i);
    expect(container.querySelector('#install-btn')).toBeNull();

    act(() => {
      parkPrompt();
      window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
    });

    expect(container.querySelector('#install-btn')).not.toBeNull();
  });
});
