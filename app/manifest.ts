import type { MetadataRoute } from 'next';

/**
 * What a browser reads before it will let anyone install this.
 *
 * Served from a route rather than a static file so the colours can be kept next
 * to the ones the stylesheet uses — a manifest whose `background_color` has
 * drifted from the app's own is a white flash on every launch, and nothing in
 * the running app ever shows it.
 *
 * `theme_color` and `background_color` are the light palette's `--bg`
 * deliberately: a manifest carries one of each, browsers pick them before any
 * page has run, and a dark launch screen in front of a light app is the more
 * jarring of the two mistakes. The `<meta name="theme-color">` tags in the
 * layout do follow the palette, and those are what the installed app's own
 * chrome uses once it is open.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Elixia Booker',
    short_name: 'Booker',
    description: 'Books your group fitness classes the moment booking opens.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f5f5fa',
    theme_color: '#f5f5fa',
    categories: ['health', 'fitness', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Full-bleed, with the mark inside the safe circle: Android crops this
      // one to whatever shape the launcher uses.
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
