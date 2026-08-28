import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import manifest from '@/app/manifest';

/**
 * The web app manifest, which is what makes this installable at all.
 *
 * Every field asserted below is one a browser refuses to install without, or
 * one whose absence produces a visibly wrong installed app — a title that says
 * `localhost`, a white flash on every launch, an icon with a white box drawn
 * around it on Android. None of it is visible in the running app in a tab, so
 * a mistake here survives every other check in this repo and only shows up on
 * someone's home screen.
 */

const value = manifest();

const file = (path: string): string => fileURLToPath(new URL(`../public${path}`, import.meta.url));

describe('the manifest', () => {
  it('names the app both in full and by the same name as a short form', () => {
    expect(value.name).toBe('Elixia Booker');
    expect(value.short_name).toBe('Elixia Booker');
  });

  it('opens as its own app rather than a browser tab', () => {
    expect(value.display).toBe('standalone');
    expect(value.start_url).toBe('/');
    expect(value.scope).toBe('/');
  });

  it('paints the launch screen in the app’s own colours, not white', () => {
    expect(value.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(value.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('ships the two icon sizes an installable app is required to have', () => {
    const sizes = (value.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  /**
   * Android crops every icon to its own shape. An icon not marked maskable is
   * shrunk into a white circle instead, which is how a launcher ends up showing
   * a small logo floating in a white blob.
   */
  it('ships a maskable icon, so Android does not draw a white box around it', () => {
    const maskable = (value.icons ?? []).filter((icon) => icon.purpose === 'maskable');
    expect(maskable.length).toBeGreaterThan(0);
    expect(maskable.some((icon) => icon.sizes === '512x512')).toBe(true);
  });

  it('points every icon at a file that is actually there', () => {
    for (const icon of value.icons ?? []) {
      expect(icon.src, icon.src).toMatch(/^\//);
      expect(existsSync(file(icon.src)), `${icon.src} is missing`).toBe(true);
      expect(statSync(file(icon.src)).size).toBeGreaterThan(0);
    }
  });

  it('registers a service worker file for the browser to install against', () => {
    expect(existsSync(file('/sw.js'))).toBe(true);
  });
});
