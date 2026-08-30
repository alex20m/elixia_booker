import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * iOS Safari and Chrome on Android both zoom the whole page in when a text
 * input's computed font-size is under 16px, and zoom back out on blur — which
 * reads as the screen jumping every time a gym/class/time field is tapped.
 * There is no stylesheet in jsdom to assert this against a live layout, so —
 * as with the mark's geometry in brand.test.tsx — the rule is pinned as text
 * straight out of the source file.
 *
 * Above a small-tablet width that zoom never happens, so the base rule's 16px
 * is only needed below it — a `@media (min-width: ...)` block claws the size
 * back down to the app's normal 14px there. @neondatabase/auth-ui's own
 * inputs (rendered on /account) already do this with Tailwind's `text-base
 * md:text-sm`, switching at its `md` breakpoint (48rem / 768px), so this
 * rule's breakpoint has to match that one or the account page's fields and
 * every other field in the app would resize at two different widths.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8');

describe('form controls on mobile', () => {
  it('never trigger the browser zoom-on-focus for gym/class/time inputs and dropdowns', () => {
    const rule = css.match(/input,\s*select\s*\{[^}]*\}/);
    expect(rule, 'expected a shared `input, select { ... }` rule in globals.css').not.toBeNull();

    const fontSize = rule?.[0]?.match(/font-size:\s*([\d.]+)px/);
    expect(fontSize, 'expected an explicit px font-size on input/select').not.toBeNull();

    expect(Number(fontSize?.[1])).toBeGreaterThanOrEqual(16);
  });

  it('goes back to the normal 14px once the screen is wide enough that no browser zooms', () => {
    const media = css.match(/@media \(min-width:\s*([\d.]+)rem\)\s*\{\s*input,\s*select\s*\{([^}]*)\}/);
    expect(
      media,
      'expected an `@media (min-width: ...) { input, select { ... } }` block sizing controls back down on wider screens',
    ).not.toBeNull();

    // 48rem is Tailwind's `md` breakpoint, which is what the account page's
    // own inputs switch on — going narrower here would zoom on a phone the
    // account page wouldn't, and going wider would shrink text on a screen
    // the account page still treats as mobile-sized.
    expect(Number(media?.[1])).toBe(48);

    const fontSize = media?.[2]?.match(/font-size:\s*([\d.]+)px/);
    expect(fontSize, 'expected an explicit px font-size in the desktop override').not.toBeNull();
    expect(Number(fontSize?.[1])).toBe(14);
  });
});
