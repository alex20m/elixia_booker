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
 * once installed same as the card, and where the browser gives no prompt to
 * replay it opens its own small popup with the steps for the platform in
 * hand — the offer is never a trip to another screen, and never a tap that
 * silently does nothing.
 */

let container: HTMLDivElement;
let root: Root;
let prompted: number;

const render = (): void => {
  act(() => {
    root.render(<InstallButton />);
  });
};

const button = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('#install-header-btn')!;

const popup = (): HTMLElement | null => container.querySelector<HTMLElement>('#install-popup');

/** Click through the DOM the way a visitor does: the event reaches document too. */
const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
      button().click();
    });

    expect(prompted).toBe(1);
    expect(popup()).toBeNull();
  });

  it('opens a popup with this platform’s own steps when there is no prompt to give', () => {
    stubBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    render();

    expect(popup()).toBeNull();
    click(button());

    expect(popup()!.textContent).toContain('Add to Home Screen');
    expect(popup()!.querySelectorAll('li')).toHaveLength(3);
    expect(button().getAttribute('aria-expanded')).toBe('true');
  });

  it('gives desktop the address-bar route rather than a phone’s share sheet', () => {
    render();
    click(button());

    expect(popup()!.textContent).toContain('address bar');
    expect(popup()!.textContent).not.toContain('Share button');
  });

  it('closes the popup when the same button is tapped again', () => {
    render();
    click(button());
    expect(popup()).not.toBeNull();

    click(button());

    expect(popup()).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the popup on Escape', () => {
    render();
    click(button());
    expect(popup()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(popup()).toBeNull();
  });

  it('closes the popup when something outside it is clicked', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    render();
    click(button());
    expect(popup()).not.toBeNull();

    click(elsewhere);

    expect(popup()).toBeNull();
    elsewhere.remove();
  });

  it('keeps the popup open while the steps themselves are being touched', () => {
    render();
    click(button());

    click(popup()!.querySelector('li')!);

    expect(popup()).not.toBeNull();
  });

  it('closes the popup from its own dismiss control', () => {
    render();
    click(button());
    expect(popup()).not.toBeNull();

    click(popup()!.querySelector<HTMLButtonElement>('#install-popup-close')!);

    expect(popup()).toBeNull();
  });

  it('says nothing at all once the app is already installed', () => {
    parkPrompt();
    stubBrowser({ standalone: true });
    render();

    expect(container.textContent).toBe('');
  });

  it('switches from the steps popup to a direct install once a prompt arrives', async () => {
    render();
    click(button());
    expect(popup()).not.toBeNull();

    act(() => {
      parkPrompt();
      window.dispatchEvent(new Event(INSTALL_PROMPT_EVENT));
    });

    expect(popup()).toBeNull();
    expect(button().getAttribute('aria-label')).toMatch(/^install app$/i);

    await act(async () => {
      button().click();
    });

    expect(prompted).toBe(1);
  });
});
