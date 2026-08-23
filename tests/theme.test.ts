// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_CHOICES,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  type ThemeChoice,
} from '@/lib/theme';

/**
 * The theme the visitor sees, and the three places it has to agree with itself:
 * the pre-hydration script that paints before React exists, the toggle that
 * changes it, and next-themes — which @neondatabase/auth-ui mounts underneath
 * the whole app with `attribute: "class"` and the default `theme` storage key.
 *
 * All three write the same key and the same class, which is what makes a
 * choice survive a reload and keeps the auth pages in the same theme as the
 * dashboard. A mismatch here is invisible in a component test — jsdom applies
 * no stylesheet — so it is pinned as behaviour instead.
 */

/** Run the blocking script the way the browser runs it, in this document. */
function runInitScript(): void {
  new Function(THEME_INIT_SCRIPT)();
}

function stubPrefersDark(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  stubPrefersDark(false);
});

describe('resolveTheme', () => {
  it('follows the operating system when the choice is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the operating system once a choice has been made', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('readThemeChoice', () => {
  it('defaults to system, so a first visit follows the OS', () => {
    expect(readThemeChoice(localStorage)).toBe('system');
  });

  it('reads back a stored choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readThemeChoice(localStorage)).toBe('dark');
  });

  it('falls back to system rather than trusting an unrecognised value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(readThemeChoice(localStorage)).toBe('system');
  });

  it('survives storage being unavailable, as it is in a locked-down browser', () => {
    const throwing = {
      getItem() {
        throw new Error('SecurityError');
      },
    };
    expect(readThemeChoice(throwing)).toBe('system');
  });
});

describe('applyTheme', () => {
  it('stamps the resolved theme as the class next-themes also writes', () => {
    applyTheme(document.documentElement, 'system', true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('replaces the previous theme instead of stacking both classes', () => {
    applyTheme(document.documentElement, 'dark', false);
    applyTheme(document.documentElement, 'light', false);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('keeps unrelated classes on the element', () => {
    document.documentElement.classList.add('js-ready');
    applyTheme(document.documentElement, 'dark', false);
    expect(document.documentElement.classList.contains('js-ready')).toBe(true);
  });
});

describe('storeThemeChoice', () => {
  it('persists the choice under the key next-themes reads', () => {
    storeThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  /**
   * next-themes owns a copy of this state and only re-reads storage when a
   * `storage` event fires. Without this notification its copy drifts, and the
   * next OS-level light/dark change would overwrite a choice the visitor made
   * by hand.
   */
  it('tells next-themes about the change so its own copy cannot drift', () => {
    const seen: Array<{ key: string | null; newValue: string | null }> = [];
    window.addEventListener('storage', (event) => {
      seen.push({ key: event.key, newValue: event.newValue });
    });

    storeThemeChoice('light');

    expect(seen).toEqual([{ key: THEME_STORAGE_KEY, newValue: 'light' }]);
  });
});

describe('nextThemeChoice', () => {
  it('cycles through every choice and back, so one control reaches all three', () => {
    const seen: ThemeChoice[] = [];
    let choice: ThemeChoice = 'system';
    for (let i = 0; i < THEME_CHOICES.length; i += 1) {
      seen.push(choice);
      choice = nextThemeChoice(choice);
    }

    expect(new Set(seen).size).toBe(THEME_CHOICES.length);
    expect(choice).toBe('system');
  });
});

describe('the pre-hydration script', () => {
  it('paints the stored theme before React exists', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    stubPrefersDark(false);

    runInitScript();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('follows the OS when nothing has been chosen', () => {
    stubPrefersDark(true);

    runInitScript();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not throw when storage is blocked, leaving the light default', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError');
      },
    });
    stubPrefersDark(false);

    expect(() => runInitScript()).not.toThrow();
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
