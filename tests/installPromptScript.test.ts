// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { INSTALL_PROMPT_EVENT, INSTALL_PROMPT_KEY, INSTALL_PROMPT_SCRIPT } from '@/lib/pwa';

/**
 * The blocking script that catches Chromium's install prompt.
 *
 * Chromium fires `beforeinstallprompt` once, early — routinely before React has
 * mounted anything. A listener attached by a component therefore misses it on
 * most loads, and the install button never appears even though the browser was
 * willing. So the event is caught here and parked on `window`.
 *
 * Evaluated exactly once, at module scope, because that is how the browser runs
 * it: re-running it per test would attach a second set of listeners and every
 * count below would double.
 */
new Function(INSTALL_PROMPT_SCRIPT)();

const parked = () => (window as unknown as Record<string, unknown>)[INSTALL_PROMPT_KEY];

let listener: (() => void) | null = null;

/** Count announcements, and stop counting when the test ends. */
function countAnnouncements(): () => number {
  let seen = 0;
  listener = () => {
    seen += 1;
  };
  window.addEventListener(INSTALL_PROMPT_EVENT, listener);
  return () => seen;
}

afterEach(() => {
  if (listener) window.removeEventListener(INSTALL_PROMPT_EVENT, listener);
  listener = null;
});

describe('the beforeinstallprompt capture script', () => {
  it('parks the event on window and announces it, with nothing mounted', () => {
    const announced = countAnnouncements();
    const event = new Event('beforeinstallprompt', { cancelable: true });

    window.dispatchEvent(event);

    expect(parked()).toBe(event);
    expect(announced()).toBe(1);
    // Left uncancelled, Chromium shows its own mini-infobar instead of ours.
    expect(event.defaultPrevented).toBe(true);
  });

  it('drops the parked event once the app has been installed', () => {
    window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(parked()).toBeTruthy();

    const announced = countAnnouncements();
    window.dispatchEvent(new Event('appinstalled'));

    expect(parked()).toBeNull();
    expect(announced()).toBe(1);
  });
});
