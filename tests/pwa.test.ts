import { describe, expect, it } from 'vitest';
import {
  detectPlatform,
  installState,
  manualInstall,
  readInstallPopupDismissed,
  standaloneFrom,
  type Platform,
} from '@/lib/pwa';

/**
 * Whether to offer to install the app, and what to say when the browser will
 * not do it for us.
 *
 * Only Chromium fires `beforeinstallprompt`. On iOS — the platform where a
 * home-screen app matters most — there is no prompt and no API at all: the
 * only route is Share ▸ Add to Home Screen, which nobody discovers on their
 * own. So "no prompt" cannot mean "hide the button", or the feature does not
 * exist for half the visitors; it means show the steps instead.
 *
 * And an app already running from the home screen must offer none of it. An
 * install button inside an installed app is the tell that this logic was never
 * thought through.
 */

const env = (overrides: {
  standalone?: boolean;
  promptAvailable?: boolean;
  platform?: Platform;
}) => ({
  standalone: false,
  promptAvailable: false,
  platform: 'desktop' as Platform,
  ...overrides,
});

describe('installState', () => {
  it('offers nothing once the app is already installed', () => {
    expect(installState(env({ standalone: true, promptAvailable: true }))).toEqual({
      kind: 'installed',
    });
  });

  it('uses the browser prompt when the browser offered one', () => {
    expect(installState(env({ promptAvailable: true, platform: 'android' }))).toEqual({
      kind: 'ready',
    });
  });

  it('falls back to instructions on a platform with no prompt API', () => {
    expect(installState(env({ platform: 'ios' }))).toEqual({ kind: 'manual', platform: 'ios' });
  });
});

describe('manualInstall', () => {
  it('gives iOS the Share sheet route, which is the only one it has', () => {
    const guide = manualInstall('ios');
    expect(guide.steps.join(' ')).toMatch(/share/i);
    expect(guide.steps.join(' ')).toMatch(/add to home screen/i);
  });

  it('points Android at the browser menu', () => {
    expect(manualInstall('android').steps.join(' ')).toMatch(/menu/i);
  });

  it('points desktop at the install control in the address bar', () => {
    expect(manualInstall('desktop').steps.join(' ')).toMatch(/address bar/i);
  });

  it('names the platform it is describing, so the panel has a heading', () => {
    for (const platform of ['ios', 'android', 'desktop'] as const) {
      expect(manualInstall(platform).title.length).toBeGreaterThan(0);
      expect(manualInstall(platform).steps.length).toBeGreaterThan(1);
    }
  });
});

describe('detectPlatform', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';

  it('recognises an iPhone', () => {
    expect(detectPlatform(IPHONE, 5)).toBe('ios');
  });

  /**
   * An iPad on iPadOS 13+ claims to be a Mac, right down to the user agent.
   * The touch points are the only thing that separates them — and getting this
   * wrong shows a Mac's "install from the address bar" advice to an iPad that
   * has no address-bar control.
   */
  it('recognises an iPad, which lies about being a Mac', () => {
    expect(detectPlatform(IPAD_OS, 5)).toBe('ios');
  });

  it('does not mistake a real Mac for an iPad', () => {
    expect(detectPlatform(MAC, 0)).toBe('desktop');
  });

  it('recognises Android', () => {
    expect(detectPlatform(ANDROID, 5)).toBe('android');
  });
});

describe('readInstallPopupDismissed', () => {
  it('is not dismissed when nothing has been stored', () => {
    expect(readInstallPopupDismissed({ getItem: () => null })).toBe(false);
  });

  it('is dismissed once the flag has been written', () => {
    expect(readInstallPopupDismissed({ getItem: () => '1' })).toBe(true);
  });

  it('treats storage that cannot be read as not dismissed', () => {
    expect(
      readInstallPopupDismissed({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(false);
  });

  it('treats a missing storage object the same as an empty one', () => {
    expect(readInstallPopupDismissed(null)).toBe(false);
    expect(readInstallPopupDismissed(undefined)).toBe(false);
  });
});

describe('standaloneFrom', () => {
  it('sees a Chromium app launched from the home screen', () => {
    expect(standaloneFrom({ displayModeStandalone: true, iosStandalone: false })).toBe(true);
  });

  /** iOS never matches display-mode; it sets navigator.standalone instead. */
  it('sees an iOS app launched from the home screen', () => {
    expect(standaloneFrom({ displayModeStandalone: false, iosStandalone: true })).toBe(true);
  });

  it('is false in an ordinary browser tab', () => {
    expect(standaloneFrom({ displayModeStandalone: false, iosStandalone: false })).toBe(false);
  });
});
