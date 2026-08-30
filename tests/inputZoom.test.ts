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
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8');

describe('form controls on mobile', () => {
  it('never trigger the browser zoom-on-focus for gym/class/time inputs and dropdowns', () => {
    const rule = css.match(/input,\s*select\s*\{[^}]*\}/);
    expect(rule, 'expected a shared `input, select { ... }` rule in globals.css').not.toBeNull();

    const fontSize = rule?.[0].match(/font-size:\s*([\d.]+)px/);
    expect(fontSize, 'expected an explicit px font-size on input/select').not.toBeNull();

    expect(Number(fontSize?.[1])).toBeGreaterThanOrEqual(16);
  });
});
