// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InstallButton } from '@/app/components/InstallCard';
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY } from '@/lib/pwa';

/**
 * The compact header install control, next to Sign out.
 *
 * It shares its installability logic with `InstallCard`, so what is worth
 * pinning here is what is different about the header form: it disappears
 * once installed same as the card, but where the browser gives no prompt to
 * replay it has no room to print steps — it has to hand off to wherever the
 * caller points it (the Settings tab), rather than silently doing nothing.
 */

let container: HTMLDivElement;
let root: Root;
let prompted: number;
let manualCalls: number;

const render = (): void => {
  act(() => {
    root.render(<InstallButton onManual={() => (manualCalls += 1)} />);
  });
};

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
  manualCalls = 0;
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

describe('InstallButton', () => {
  it('installs directly when the browser handed us a prompt to replay', async () => {
    parkPrompt();
    render();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('#install-header-btn')!.click();
    });

    expect(prompted).toBe(1);
    expect(manualCalls).toBe(0);
  });

  it('hands off to the caller instead, on a browser with no prompt to give', () => {
    stubBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    render();

    act(() => {
      container.querySelector<HTMLButtonElement>('#install-header-btn')!.click();
    });

    expect(manualCalls).toBe(1);
    expect(prompted).toBe(0);
  });

  it('says nothing at all once the app is already installed', () => {
    parkPrompt();
    stubBrowser({ standalone: true });
    render();

    expect(container.textContent).toBe('');
  });

  it('switches from a hand-off to a direct install once a prompt arrives', async () => {
    render();
    const btn = () => container.querySelector<HTMLButtonElement>('#install-header-btn')!;
    expect(btn().getAttribute('aria-label')).toMatch(/how to install/i);

    act(() => {
      parkPrompt();
      window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
    });

    expect(btn().getAttribute('aria-label')).toMatch(/^install app$/i);

    await act(async () => {
      btn().click();
    });

    expect(prompted).toBe(1);
    expect(manualCalls).toBe(0);
  });
});
