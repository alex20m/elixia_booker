import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Every `<button>` should show a pointer on hover, on desktop, whoever
 * renders it. There is no stylesheet in jsdom to assert this against a live
 * cascade, so — as with the zoom-prevention rule in inputZoom.test.ts — the
 * rule is pinned as text straight out of the source file.
 *
 * The bug this guards: the app's own button look
 * (`button:where(:not([data-slot])) { ... cursor: pointer ... }`) is
 * deliberately scoped off @neondatabase/auth-ui's own controls, which all
 * carry a `data-slot` attribute — see the comment above that rule. That guard
 * exists to stop this app's filled-button background from painting over
 * auth-ui's own themed buttons, but a cursor rule nested inside it was
 * scoped off them too as a side effect. auth-ui's own button component sets
 * no cursor of its own (shadcn's buttonVariants has none), so every button on
 * /account — Save, Cancel, Delete Account, the dialog's close icon — fell
 * back to the browser's plain arrow. A rule that only reappears inside the
 * `:not([data-slot])`-guarded block would still miss them.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8');

describe('buttons on desktop', () => {
  it('always get a pointer cursor, including auth-ui’s own [data-slot] buttons on /account', () => {
    const rule = css.match(/(?:^|\n)button\s*\{([^}]*)\}/);
    expect(
      rule,
      'expected a plain `button { ... }` rule in globals.css, not scoped by :not([data-slot])',
    ).not.toBeNull();

    expect(rule?.[1]).toMatch(/cursor:\s*pointer;/);
  });

  it('show not-allowed once disabled, for every button regardless of data-slot', () => {
    const rule = css.match(/(?:^|\n)button:disabled\s*\{([^}]*)\}/);
    expect(
      rule,
      'expected a plain `button:disabled { ... }` rule in globals.css, not scoped by :not([data-slot])',
    ).not.toBeNull();

    expect(rule?.[1]).toMatch(/cursor:\s*not-allowed;/);
  });
});
