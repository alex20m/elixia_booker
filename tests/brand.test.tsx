// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LogoMark } from '@/app/components/Brand';
import manifest from '@/app/manifest';

/**
 * The mark, in the four shapes it actually ships as.
 *
 * None of this is visible in the running app: `icon.svg` is fetched by the
 * browser with no page around it, and the PNGs only ever appear on a home
 * screen or in a launcher. A mistake in any of them survives every other check
 * in this repo and shows up on somebody's phone, which is why the shapes are
 * asserted here rather than trusted to whoever last re-exported them.
 */

/*
 * Resolved through `node:path` rather than `new URL(..., import.meta.url)`,
 * which is the idiom the other tests here use. This file runs under jsdom, and
 * jsdom's `URL` is not Node's: hand one of its instances to `fileURLToPath` and
 * it returns a path that points nowhere, without throwing.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = (path: string): string => resolve(root, path);
const read = (path: string): string => readFileSync(file(path), 'utf8');

/**
 * The drawing instructions inside a mark, with the tile and the colours taken
 * out: transforms, rects and paths in source order.
 *
 * The point is to compare the geometry of the SVG against the geometry of the
 * component without tripping over the one difference that is supposed to exist
 * — `icon.svg` names its colours outright because nothing is going to give it a
 * stylesheet, and the component reads them from custom properties.
 */
function geometry(markup: string): string {
  return (
    markup
      // Whichever way the two files spell the same attribute.
      .replace(/\s*\/>/g, '/>')
      .replace(/fill="[^"]*"/g, '')
      // The tile, which legitimately differs: the favicon is cut to rx 8 and
      // the in-app mark to rx 12.
      .replace(/<rect width="48" height="48"[^/]*\/>/, '')
      .match(/(transform="[^"]*"|<rect [^/]*\/>|<path d="[^"]*"\/>)/g) ?? []
  ).join('\n');
}

describe('the mark', () => {
  /**
   * The same lockup is drawn twice — once in `app/icon.svg` for the browser,
   * once in `Brand.tsx` for the app — and there is no build step tying them
   * together. Left unchecked, one of them gets a nudge and the phone icon and
   * the app bar quietly stop being the same logo.
   */
  it('is drawn identically in icon.svg and in the component', () => {
    expect(geometry(read('app/icon.svg'))).toBe(geometry(read('app/components/Brand.tsx')));
  });

  it('takes its colours from the palette, so a theme change carries', () => {
    const container = document.createElement('div');
    act(() => {
      createRoot(container).render(<LogoMark />);
    });
    const fills = [...container.querySelectorAll('[fill]')].map((el) => el.getAttribute('fill'));

    expect(fills).toContain('var(--brand-tile, #0d2134)');
    expect(fills).toContain('var(--brand-ink, #ffffff)');
    expect(fills).toContain('var(--brand-accent, #fa5333)');
    // The B is not the same colour as the E — the thing every fallback has to
    // preserve, and the easiest to lose by copying one var() over another.
    expect(new Set(fills).size).toBe(3);
  });
});

/* ------------------------------------------------------------------ PNGs -- */

type Png = { width: number; height: number; pixel: (x: number, y: number) => number[] };

/**
 * Enough of a PNG decoder to answer "what does this icon look like".
 *
 * Only what the export script emits: 8-bit, non-interlaced, RGB or RGBA. It is
 * a dozen lines because the alternative is asserting on file size, which is not
 * an assertion about anything.
 */
function decodePng(path: string): Png {
  const buf = readFileSync(file(path));
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('ascii');
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8], `${path} is not 8-bit`).toBe(8);
      expect(body[12], `${path} is interlaced`).toBe(0);
      channels = body[9] === 6 ? 4 : 3;
      expect([2, 6], `${path} has an unexpected colour type`).toContain(body[9]);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Every PNG uses them; ignoring them would
  // read noise and pass anyway, which is worse than not looking.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = (i >= channels ? out[y * stride + i - channels] : 0) ?? 0;
      const b = (y > 0 ? out[(y - 1) * stride + i] : 0) ?? 0;
      const c = (i >= channels && y > 0 ? out[(y - 1) * stride + i - channels] : 0) ?? 0;
      let value = line[i] ?? 0;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    pixel: (x, y) => [...out.subarray((y * width + x) * channels, (y * width + x) * channels + channels)],
  };
}

/** Where the white-and-coral lockup sits inside an icon, in pixels. */
function markBounds(png: Png): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = png.width;
  let maxX = -1;
  let minY = png.height;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r = 0, g = 0, b = 0] = png.pixel(x, y);
      // Navy is #0d2134; both the white E and the coral B are far off it.
      if (r > 60 || g > 70 || b > 90) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

describe('the exported icons', () => {
  it('are the sizes the manifest promises browsers they are', () => {
    for (const icon of manifest().icons ?? []) {
      const png = decodePng(`public${icon.src}`);
      expect(`${png.width}x${png.height}`, icon.src).toBe(icon.sizes);
    }
  });

  /**
   * Android crops a maskable icon to whatever shape the launcher uses, and
   * guarantees only the circle covering the middle 80%. This lockup is wide,
   * so it is the corners of its bounding box that fall off the edge first —
   * scale it up by a few percent and the B loses its bowls on a round launcher,
   * on someone else's phone, silently.
   */
  it('keep the mark inside the safe circle of the maskable icon', () => {
    const png = decodePng('public/icons/maskable-512.png');
    const { minX, maxX, minY, maxY } = markBounds(png);
    const halfDiagonal = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2);

    expect(halfDiagonal).toBeLessThanOrEqual(png.width * 0.4);
  });

  it('centre the mark in the maskable icon', () => {
    const png = decodePng('public/icons/maskable-512.png');
    const { minX, maxX, minY, maxY } = markBounds(png);

    expect(Math.abs((minX + maxX) / 2 - png.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs((minY + maxY) / 2 - png.height / 2)).toBeLessThanOrEqual(2);
  });

  /**
   * The two shapes are not the same picture, and the difference is the whole
   * reason both exist: a maskable icon painted with the rounded tile gets that
   * tile cropped again by the launcher, which is how an icon ends up with its
   * corners shaved twice.
   */
  it('bleed the maskable icon to the edge and round the plain one', () => {
    expect(decodePng('public/icons/maskable-512.png').pixel(0, 0)).toEqual([13, 33, 52]);
    expect(decodePng('public/icons/icon-512.png').pixel(0, 0)[3]).toBe(0);
  });

  /** iOS composites over black, so a transparent corner is a black corner. */
  it('leave no transparent corner on the icon iOS uses', () => {
    const png = decodePng('app/apple-icon.png');
    expect(png.pixel(0, 0)).toEqual([13, 33, 52]);
  });
});
