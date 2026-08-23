// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstallCard } from '@/app/components/InstallCard';
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa';

/**
 * The card that offers to install the app.
 *
 * Three things have to hold, and each is invisible on the developer's own
 * machine — which is where a PWA install offer is least likely to be exercised
 * and most likely to be wrong. It must appear on a browser with no install API
 * at all (iOS, where it matters most), it must disappear once the app is
 * installed, and pressing it must actually call the browser's prompt rather
 * than only looking like it did.
 */

let container: HTMLDivElement;
let root: Root;
let prompted: number;

const render = (): void => {
  act(() => {
    root.render(<InstallCard />);
  });
};

/** Pretend Chromium already handed us an install prompt, as its script does. */
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

describe('InstallCard', () => {
  it('offers a one-tap install when the browser gave us a prompt', () => {
    parkPrompt();
    render();

    expect(container.querySelector('#install-btn')).not.toBeNull();
  });

  it('actually asks the browser, rather than only looking like it did', async () => {
    parkPrompt();
    render();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('#install-btn')!.click();
    });

    expect(prompted).toBe(1);
  });

  /** The platform with no install API is the one that needs the card most. */
  it('shows the Share-sheet steps on iOS, where there is no prompt to give', () => {
    stubBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    render();

    expect(container.querySelector('#install-btn')).toBeNull();
    expect(container.textContent).toMatch(/add to home screen/i);
  });

  it('says nothing at all once the app is already installed', () => {
    parkPrompt();
    stubBrowser({ standalone: true });
    render();

    expect(container.textContent).toBe('');
  });

  /**
   * The prompt commonly arrives after the first render — that is the whole
   * reason it is parked on `window` by a script instead of caught by a
   * component. The card has to notice when it lands.
   */
  it('appears when the prompt arrives after the page has already rendered', () => {
    render();
    expect(container.querySelector('#install-btn')).toBeNull();

    act(() => {
      parkPrompt();
      window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
    });

    expect(container.querySelector('#install-btn')).not.toBeNull();
  });
});
