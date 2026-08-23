/**
 * Installing the app to a home screen or a dock.
 *
 * The browsers disagree about this more than any other feature here. Chromium
 * fires `beforeinstallprompt`, which can be saved and replayed from a button of
 * our own. Safari fires nothing and exposes no API: on iOS the only route is
 * Share ▸ Add to Home Screen, a menu item almost nobody finds by accident.
 *
 * So the rule is that the offer is always visible somewhere, and only its
 * *form* changes — a one-tap button where the browser allows one, the actual
 * steps where it does not. The one case with nothing to offer is an app already
 * running installed, which is also the case a naive implementation gets wrong.
 */

export type Platform = 'ios' | 'android' | 'desktop';

export type InstallState =
  /** Already launched from a home screen or dock: there is nothing to offer. */
  | { kind: 'installed' }
  /** The browser handed us a prompt to replay. */
  | { kind: 'ready' }
  /** No prompt API here — say how to do it by hand. */
  | { kind: 'manual'; platform: Platform };

export interface InstallEnvironment {
  standalone: boolean;
  promptAvailable: boolean;
  platform: Platform;
}

export function installState({
  standalone,
  promptAvailable,
  platform,
}: InstallEnvironment): InstallState {
  if (standalone) return { kind: 'installed' };
  if (promptAvailable) return { kind: 'ready' };
  return { kind: 'manual', platform };
}

export interface ManualInstall {
  title: string;
  steps: string[];
}

/** The by-hand route, in the words of the platform the visitor is holding. */
export function manualInstall(platform: Platform): ManualInstall {
  switch (platform) {
    case 'ios':
      return {
        title: 'Add to your Home Screen',
        steps: [
          'Tap the Share button in your browser.',
          'Scroll down and choose “Add to Home Screen”.',
          'Tap Add. Elixia Booker opens like any other app.',
        ],
      };
    case 'android':
      return {
        title: 'Add to your Home screen',
        steps: [
          'Open your browser’s ⋮ menu.',
          'Choose “Install app” or “Add to Home screen”.',
          'Confirm, and Elixia Booker opens like any other app.',
        ],
      };
    case 'desktop':
      return {
        title: 'Install on this computer',
        steps: [
          'Look for the install icon at the end of the address bar.',
          'Choose Install, or find it under the browser’s ⋮ menu.',
          'Elixia Booker opens in its own window.',
        ],
      };
  }
}

/**
 * Which platform this is.
 *
 * iPadOS 13 and later report a desktop Mac user agent, deliberately and with no
 * override — the touch points are the only thing that gives them away. Reading
 * it wrong shows an iPad the advice for a browser chrome it does not have.
 */
export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform {
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios';
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return 'desktop';
}

/**
 * Whether the app is already running installed.
 *
 * Two signals because the platforms report it in different places: Chromium
 * matches the `display-mode: standalone` media query, and iOS Safari — which
 * matches nothing — sets a non-standard `navigator.standalone` instead.
 */
export function standaloneFrom({
  displayModeStandalone,
  iosStandalone,
}: {
  displayModeStandalone: boolean;
  iosStandalone: boolean;
}): boolean {
  return displayModeStandalone || iosStandalone;
}

/** Read the two signals above off the live browser. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return standaloneFrom({
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    iosStandalone: (window.navigator as { standalone?: boolean }).standalone === true,
  });
}

/** Read the platform off the live browser. */
export function currentPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';
  return detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/**
 * The event Chromium fires, minus the parts nothing here uses.
 *
 * Typed locally because it is not in lib.dom: it is a Chromium extension, and
 * the whole point of the code around it is that other browsers never fire it.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Where the captured install event is parked, and how its arrival is announced.
 *
 * Both are read by the script below and by the component that renders the
 * button, so they are named once rather than spelled out in two places that
 * could drift.
 */
export const INSTALL_PROMPT_KEY = '__elixiaInstallPrompt';
export const INSTALL_PROMPT_EVENT = 'elixia:installprompt';

/**
 * The script that catches Chromium's install prompt.
 *
 * `beforeinstallprompt` fires once, and it fires early — routinely before React
 * has mounted anything at all. A listener attached from a component therefore
 * misses it on most loads, and the result is an install button that never
 * appears on a browser that was perfectly willing to install the app. So the
 * event is caught here, in a blocking script, and parked on `window` for
 * whatever mounts later.
 *
 * `preventDefault` is not optional either: without it Chromium shows its own
 * mini-infobar, which is both easy to miss and impossible to bring back.
 */
export const INSTALL_PROMPT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  INSTALL_PROMPT_KEY,
)},n=${JSON.stringify(
  INSTALL_PROMPT_EVENT,
)};window[k]=window[k]||null;window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window[k]=e;window.dispatchEvent(new Event(n));});window.addEventListener("appinstalled",function(){window[k]=null;window.dispatchEvent(new Event(n));});}catch(e){}})();`;

/** The parked event, if the browser ever offered one. */
export function parkedInstallPrompt(): BeforeInstallPromptEvent | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as Record<string, BeforeInstallPromptEvent | null>)[
    INSTALL_PROMPT_KEY
  ] ?? null;
}
