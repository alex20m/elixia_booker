// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import RootLayout from '@/app/layout';

/**
 * The root <html> element is mutated before React hydrates, and the layout has
 * to tolerate it.
 *
 * `@neondatabase/auth-ui`'s NeonAuthUIProvider wraps its children in
 * next-themes' ThemeProvider with `attribute: "class"` and `enableSystem`.
 * next-themes cannot know the visitor's theme on the server — it lives in
 * localStorage and in the OS setting — so it ships a blocking inline script
 * that stamps `class="dark"` and `style="color-scheme: dark"` onto
 * `document.documentElement` while the HTML is still streaming, i.e. before
 * hydration starts. The server markup therefore never carries those, and the
 * DOM React hydrates against always does, for every dark-mode visitor.
 *
 * React reports that as a hydration mismatch on <html> and leaves it unpatched.
 * `suppressHydrationWarning` on that one element is the sanctioned answer: it
 * applies only to the element it is set on, not to its subtree, so real
 * mismatches inside the page are still reported.
 */

/** What the next-themes pre-hydration script does to <html> in dark mode. */
function applyPreHydrationThemeScript(): void {
  document.documentElement.classList.add('dark');
  document.documentElement.style.colorScheme = 'dark';
}

let hydrationErrors: string[];
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  hydrationErrors = [];
  consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    hydrationErrors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

/** Server-render `tree` into the jsdom document, exactly as Next would ship it. */
function serverRender(tree: React.ReactElement): void {
  const html = renderToString(tree);
  document.open();
  document.write(`<!DOCTYPE html>${html}`);
  document.close();
}

function mismatchReports(): string[] {
  return hydrationErrors.filter((message) => /hydrat/i.test(message));
}

describe('RootLayout', () => {
  it('hydrates cleanly when the theme script has already darkened <html>', async () => {
    const page = <RootLayout>page content</RootLayout>;

    serverRender(page);
    applyPreHydrationThemeScript();

    await act(async () => {
      hydrateRoot(document, page);
    });

    expect(mismatchReports()).toEqual([]);
  });

  /**
   * Guards the test above from passing vacuously. If the console capture or the
   * hydrate call silently did nothing, an unmistakable mismatch would go
   * unreported too — so assert that one is caught.
   */
  it('detects an <html> attribute mismatch when it is not suppressed', async () => {
    const unsuppressed = (
      <html lang="en">
        <body>page content</body>
      </html>
    );

    serverRender(unsuppressed);
    applyPreHydrationThemeScript();

    await act(async () => {
      hydrateRoot(document, unsuppressed);
    });

    expect(mismatchReports().join('\n')).toMatch(/didn't match/i);
  });
});
