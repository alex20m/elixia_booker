/**
 * The service worker that makes Elixia Booker installable.
 *
 * Deliberately small, and deliberately timid about what it will answer. A
 * service worker outlives the page that registered it and sits in front of
 * every request the app makes, so the failure mode of an over-eager one is an
 * app that looks fine and is quietly serving something stale — a dashboard
 * belonging to whoever used the browser last, or a booking request answered
 * from cache when it never left the device.
 *
 * The rules, in order of how much they matter:
 *
 *   1. `/api/*` is never intercepted. It carries the session and every
 *      mutation, and those must fail loudly rather than succeed from a cache.
 *   2. HTML is never stored. Pages come from the network; when the network is
 *      gone the offline page is shown instead. There is nothing in between
 *      worth the risk of showing one account another's classes.
 *   3. Fingerprinted static assets are cached forever, because their URL
 *      changes when their content does — that is what makes it safe.
 *
 * Written by hand rather than generated: there are three rules, and a
 * generated worker is a large amount of code whose caching decisions nobody
 * here would be able to audit.
 */

const VERSION = 'v1';
const SHELL_CACHE = 'elixia-shell-' + VERSION;
const ASSET_CACHE = 'elixia-assets-' + VERSION;
const KEEP = [SHELL_CACHE, ASSET_CACHE];

const OFFLINE_URL = '/offline';

/** Everything the app needs to say something useful with no network at all. */
const SHELL = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.map((name) => (KEEP.includes(name) ? undefined : caches.delete(name)))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Whether this URL's content is pinned to its path.
 *
 * Next fingerprints everything under `/_next/static`, and the icons are part of
 * the installed app's identity — both change name when they change content, so
 * a cached copy can never go stale. Anything else is left to the network.
 */
function isImmutableAsset(pathname) {
  return pathname.startsWith('/_next/static/') || pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Rule 1. Everything this app actually does goes through here.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Rule 2: asked for, never kept. `caches.match` reaches the precached copy
    // put there at install, which is the only HTML this worker will ever serve.
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((offline) => offline || Response.error()),
      ),
    );
    return;
  }

  if (!isImmutableAsset(url.pathname)) return;

  // Rule 3. The clone happens before the response is handed back, because a
  // body can only be read once and the page is about to read it.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        }),
    ),
  );
});
