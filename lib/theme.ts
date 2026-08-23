/**
 * Which palette the app paints itself in.
 *
 * Three things decide it and all three have to agree, or the theme flickers on
 * load or quietly forgets what the visitor chose:
 *
 *   * **A blocking script**, run before the first paint, so the page never
 *     appears in the wrong palette and then corrects itself.
 *   * **The toggle**, which writes the choice down.
 *   * **next-themes**, which `@neondatabase/auth-ui` mounts underneath the whole
 *     app with `attribute: "class"` and its default `theme` storage key — it is
 *     what keeps Neon's own sign-in and account pages in the same palette.
 *
 * Agreeing means using next-themes' key and its class convention rather than
 * inventing a parallel one: the resolved theme is the class on `<html>`, and
 * the choice — including `system`, which is not a palette but a rule for
 * picking one — is what gets stored.
 */

export const THEME_STORAGE_KEY = 'theme';

/** What the visitor picked, which is not the same as what they see. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The palette actually painted. */
export type ResolvedTheme = 'light' | 'dark';

/** Ordered as the toggle cycles them: follow the OS, then override either way. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

/** The next choice in the cycle, so one button can reach all three. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(choice);
  // `THEME_CHOICES` is non-empty and the modulo keeps the index inside it, so
  // this can only be undefined to a compiler that cannot see either fact.
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length] ?? 'system';
}

/**
 * The stored choice, defaulting to following the OS.
 *
 * Reading is wrapped because `localStorage` is not merely empty in a browser
 * with site data blocked — the property access itself throws, and an
 * unhandled throw here would take the whole app down before it rendered.
 */
export function readThemeChoice(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Write the choice down, and tell next-themes about it.
 *
 * The synthetic `storage` event is the part that matters: next-themes keeps its
 * own copy of this value in React state and only re-reads storage when that
 * event fires. Without it, its copy still says `system` after the visitor has
 * chosen `dark`, and the next time the OS switches palette next-themes would
 * helpfully overwrite their choice.
 */
export function storeThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A choice that cannot be remembered still applies for this visit.
  }
  window.dispatchEvent(
    new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: choice }),
  );
}

/**
 * Paint `root` in the chosen theme.
 *
 * The class is the resolved palette, not the choice, because that is what
 * next-themes writes and what the stylesheet keys off. `colorScheme` comes with
 * it so form controls, scrollbars and the browser's own chrome follow.
 */
export function applyTheme(root: HTMLElement, choice: ThemeChoice, prefersDark: boolean): void {
  const resolved = resolveTheme(choice, prefersDark);
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

/**
 * The OS preference, or light where it cannot be asked.
 *
 * `matchMedia` is guarded rather than assumed: it is absent while rendering on
 * the server, and absent again in some embedded webviews. Neither is a reason
 * for the app to fail to render, and "light" is the safe answer in both.
 */
export function prefersDarkNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** Subscribe to OS-level palette changes; returns the unsubscribe. */
export function watchPrefersDark(listener: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent): void => listener(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

/**
 * The script that runs before anything is painted.
 *
 * Inlined into <head> rather than imported, because a module cannot run before
 * the browser paints the markup above it — and a page that appears white and
 * then turns dark is the one theming bug every visitor notices. It is written
 * out longhand (no imports, no optional chaining on globals) because it is
 * executed as text, and it duplicates `applyTheme`'s three lines on purpose:
 * the alternative is shipping the whole module twice.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var c=null;try{c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});}catch(e){}if(c!=="light"&&c!=="dark"&&c!=="system"){c="system";}var d=c==="dark"||(c==="system"&&typeof matchMedia==="function"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(d?"dark":"light");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
