/**
 * Rasterise the app icons from `app/icon.svg`.
 *
 * The PNG icons are the same mark as the SVG, and the only way to keep them
 * that way is to generate them from it rather than to draw them twice. Run
 * this whenever the mark changes, and commit what it writes:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/export-icons.mjs
 *
 * Installed with `--no-save` on purpose: a browser driver has no business in
 * this app's dependency tree, and CI has no reason to download one.
 *
 * Chromium does the rasterising because it is the renderer the icon has to
 * survive anyway, and because it needs no native build step — a resvg or sharp
 * dependency would be a compiled module in the tree for a job that runs a
 * handful of times a year. This deliberately is not wired into `npm run build`
 * or CI: a deploy must not depend on a browser download, and an icon that
 * silently re-renders on every build is an icon nobody notices going wrong.
 *
 * Four shapes come out of it, and they are not the same picture:
 *
 * - `icon-192` / `icon-512` are the tile as drawn, rounded corners and all, on
 *   transparency. These are what a browser shows when it wants an icon as-is.
 * - `maskable-512` is full-bleed navy with no rounded corners, and the mark
 *   pulled in to `MASKABLE_SCALE`. Android crops this to whatever shape the
 *   launcher uses, so anything outside the safe circle — 80% of the width — is
 *   liable to be cut off. The lockup is wide, so it is the corners of its
 *   bounding box that decide the scale, not its width.
 * - `apple-icon` is opaque and square: iOS applies its own mask and composites
 *   over black, so transparent corners come out as black ones.
 * - `favicon.ico` is the tile again, rendered at 16/32/48px and packed into one
 *   ICO container. This exists because `app/icon.svg` alone renders fine as a
 *   browser-tab favicon but isn't enough for tools that look for a favicon by
 *   fetching `/favicon.ico` directly rather than reading the page's <link>
 *   tags — the Vercel project dashboard among them. The container just holds
 *   three raw PNGs (the format modern ICO readers accept since Vista), so no
 *   ICO-encoding dependency is needed — `buildIco` below does the packing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Resolved at run time, not imported at the top, so the failure is a sentence
   rather than a stack trace in a repo that deliberately does not depend on it. */
const { chromium } = await import('playwright').catch(() => {
  console.error(
    'This needs Playwright, which is not a dependency of this app.\n' +
      '  npm i --no-save playwright && npx playwright install chromium',
  );
  process.exit(1);
});

const NAVY = '#0d2134';
/* Keeps the lockup's corners inside Android's safe circle; see above. */
const MASKABLE_SCALE = 0.86;
const FAVICON_SIZES = [16, 32, 48];

const targets = [
  { out: 'public/icons/icon-192.png', size: 192, shape: 'tile' },
  { out: 'public/icons/icon-512.png', size: 512, shape: 'tile' },
  { out: 'public/icons/maskable-512.png', size: 512, shape: 'maskable' },
  { out: 'app/apple-icon.png', size: 180, shape: 'opaque' },
];

/* Packs raw PNGs into an ICO container (PNG-in-ICO, supported since Windows
   Vista and by every modern favicon reader) — one ICONDIR header, one
   ICONDIRENTRY per image, then the PNG bytes back to back. */
function buildIco(pngs) {
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + entrySize * pngs.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = dirSize;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const page = (svg, { size, shape }) => {
  /* The tile's rounded corners live in the SVG itself, so the maskable and
     opaque variants have to paint over them rather than ask for them back. */
  const bleed =
    shape === 'tile'
      ? ''
      : `<rect width="48" height="48" fill="${NAVY}"/>`;
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<rect width="48" height="48" rx="8"[^/]*\/>/, '');
  const scale = shape === 'maskable' ? MASKABLE_SCALE : 1;
  const art =
    shape === 'tile'
      ? svg
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">${bleed}` +
        `<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">${inner}</g></svg>`;
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style>${art}`;
};

const svg = await readFile(resolve(root, 'app/icon.svg'), 'utf8');
const browser = await chromium.launch();

for (const target of targets) {
  const tab = await browser.newPage({
    viewport: { width: target.size, height: target.size },
    deviceScaleFactor: 1,
  });
  await tab.setContent(page(svg, target), { waitUntil: 'load' });
  const shot = await tab.locator('svg').screenshot({
    omitBackground: target.shape !== 'opaque',
    type: 'png',
  });
  const out = resolve(root, target.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, shot);
  console.log(`${target.out}  ${target.size}×${target.size}  ${shot.length} bytes`);
  await tab.close();
}

const faviconPngs = [];
for (const size of FAVICON_SIZES) {
  const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await tab.setContent(page(svg, { size, shape: 'tile' }), { waitUntil: 'load' });
  const shot = await tab.locator('svg').screenshot({ omitBackground: true, type: 'png' });
  faviconPngs.push({ size, data: shot });
  await tab.close();
}
const favicon = buildIco(faviconPngs);
const faviconOut = resolve(root, 'app/favicon.ico');
await writeFile(faviconOut, favicon);
console.log(`app/favicon.ico  ${FAVICON_SIZES.join('+')}px  ${favicon.length} bytes`);

await browser.close();
