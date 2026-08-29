// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INSTALL_PROMPT_KEY } from '@/lib/pwa';

vi.mock('@/lib/auth/client', () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));

const { SignedOut } = await import('@/app/DashboardApp');

/**
 * The screen someone who is not signed in lands on.
 *
 * It is the app's front door and its only job is to get one of two decisions
 * made, so what it must *not* carry is as much of the specification as what it
 * must. It used to end in the install offer — a numbered how-to for putting an
 * icon on a home screen, shown to a visitor who does not have an account yet
 * and on a phone taller than everything above it. The install offer itself is
 * unchanged and still lives in Settings and at the end of setup; the point
 * here is that it is not on this screen.
 */

let container: HTMLDivElement;
let root: Root;

/**
 * A browser the install offer would definitely speak up on, so that "no
 * install offer here" is a claim about this screen rather than about jsdom.
 * `installCard.test.tsx` pins the offer's own behaviour on the same stubs.
 */
function stubInstallableBrowser(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0)',
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
  (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY] = {
    prompt: async () => {},
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  };
}

beforeEach(() => {
  stubInstallableBrowser();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<SignedOut />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY];
});

describe('the signed-out screen', () => {
  it('offers exactly the two ways in, and nothing else to press', () => {
    const signIn = container.querySelector<HTMLAnchorElement>('#auth-btn');
    const signUp = container.querySelector<HTMLAnchorElement>('#auth-toggle');

    expect(signIn?.textContent).toBe('Sign in');
    expect(signIn?.getAttribute('href')).toBe('/auth/sign-in');
    expect(signUp?.textContent).toBe('Create an account');
    expect(signUp?.getAttribute('href')).toBe('/auth/sign-up');
    // The header carries no install button here either — there is no menu and
    // no theme control on this screen, so this is the whole set of controls.
    expect(container.querySelectorAll('a, button')).toHaveLength(2);
  });

  it('does not put the install instructions in front of someone without an account', () => {
    expect(container.textContent).not.toMatch(/Install/i);
    expect(container.querySelector('.install-steps')).toBeNull();
    expect(container.querySelector('#install-btn')).toBeNull();
  });

  it('says what the app does before asking anyone to sign up for it', () => {
    expect(container.querySelector('h1')?.textContent).toBe('Never miss a class again.');
    expect(container.querySelector('.hero-sub')?.textContent).toMatch(/books them/);
  });
});

/**
 * The stylesheet's own base button rule, which paints a filled background on
 * every button it matches.
 *
 * @neondatabase/auth-ui renders its controls into the same document, and its
 * link-style buttons set a text colour and no background at all — so a rule
 * matching a bare `button` filled them in with `--primary-bg` while their
 * label stayed `--foreground`, both bridged to the same navy. "Sign In" under
 * the sign-up form came out as a solid navy block with no readable text on it,
 * and a white one in dark mode. Nothing in a jsdom render can see this: no
 * stylesheet is applied there, so the rule is asserted where it is written.
 */
describe('the base button styles', () => {
  it('never claim a button that @neondatabase/auth-ui rendered', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((match) => (match[1] ?? '').trim())
      .filter((selector) => !selector.startsWith('@'))
      .flatMap((list) => list.split(','))
      .map((selector) => selector.trim())
      .filter(Boolean);

    const unguarded = selectors.filter((selector) => {
      // Only the subject matters: `.appbar button.btn-quiet` styles one of ours.
      const subject = selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
      // `:not(…)` narrows what a selector matches, so it cannot be what makes
      // one specific to this app's own buttons — strip it before asking.
      const qualifiers = subject.replace(/:not\([^)]*\)/g, '');
      if (!/^button(?![\w-])/.test(qualifiers)) return false;
      if (/[.#[]/.test(qualifiers)) return false;
      return !subject.includes(':not([data-slot])');
    });

    expect(unguarded).toEqual([]);
  });

  /**
   * And the guard has to be free, not merely present.
   *
   * `:not([data-slot])` carries its argument's specificity, so bolting it onto
   * `button` lifted this rule from (0,0,1) to (0,1,1) — one step above a lone
   * class. Every control that opts out of the filled look does so with exactly
   * one: `.nav-link` in the bar, `.menu-item` in the menu. All of them lost,
   * and the bar's section links and the menu's rows started rendering as
   * filled primary buttons — invisible navy-on-navy in light, white slabs in
   * dark. `:where()` matches precisely the same elements and contributes
   * nothing, which is what keeps the opt-outs working.
   */
  it('cost nothing in specificity, so one class still opts out of the filled look', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    const guards = css.match(/:not\(\[data-slot\]\)/g) ?? [];
    const free = css.match(/:where\(:not\(\[data-slot\]\)\)/g) ?? [];

    // Without this the assertion below passes by having no guards at all.
    expect(guards.length).toBeGreaterThan(0);
    expect(free.length).toBe(guards.length);
  });
});
