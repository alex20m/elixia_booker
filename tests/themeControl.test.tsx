// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeChoiceControl, ThemeToggle } from '@/app/components/theme';
import { THEME_STORAGE_KEY } from '@/lib/theme';

/**
 * The two controls that change the palette.
 *
 * What is worth pinning is not that a button renders but that pressing it
 * *paints* — the class on <html> is what the stylesheet keys off, and a control
 * that only updates React state looks completely correct in a component test
 * while doing nothing at all in a browser. The choice also has to be written
 * down, because a theme that resets on every reload is the bug people report as
 * "dark mode does not work".
 */

let container: HTMLDivElement;
let root: Root;

const render = (node: React.ReactElement): void => {
  act(() => {
    root.render(node);
  });
};

const byId = <T extends HTMLElement>(id: string): T => container.querySelector<T>(`#${id}`)!;

const click = (id: string): void => {
  act(() => {
    byId<HTMLButtonElement>(id).click();
  });
};

function stubPrefersDark(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  stubPrefersDark(false);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ThemeChoiceControl', () => {
  it('opens on the stored choice, and marks it as the one in effect', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<ThemeChoiceControl />);

    expect(byId('theme-dark').getAttribute('aria-checked')).toBe('true');
    expect(byId('theme-system').getAttribute('aria-checked')).toBe('false');
  });

  it('defaults to following the system, which is what a first visit gets', () => {
    render(<ThemeChoiceControl />);
    expect(byId('theme-system').getAttribute('aria-checked')).toBe('true');
  });

  it('paints the page and remembers the choice', () => {
    render(<ThemeChoiceControl />);

    click('theme-dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('goes back to the system palette when system is chosen again', () => {
    stubPrefersDark(true);
    render(<ThemeChoiceControl />);

    click('theme-light');
    expect(document.documentElement.classList.contains('light')).toBe(true);

    click('theme-system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});

describe('ThemeToggle', () => {
  it('reaches every choice from one button', () => {
    render(<ThemeToggle />);

    const seen = new Set<string | null>();
    for (let i = 0; i < 3; i += 1) {
      click('theme-toggle');
      seen.add(localStorage.getItem(THEME_STORAGE_KEY));
    }

    expect(seen).toEqual(new Set(['system', 'light', 'dark']));
  });

  /** An icon-only control still has to say what it does. */
  it('names the state it will move to', () => {
    render(<ThemeToggle />);
    const label = byId('theme-toggle').getAttribute('aria-label') ?? '';
    expect(label.length).toBeGreaterThan(0);
    expect(label).toMatch(/theme/i);
  });
});
