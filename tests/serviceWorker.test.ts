import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The service worker, driven the way a browser drives it.
 *
 * A service worker is the one piece of this app that can break the app while
 * looking installed and healthy: it sits in front of every request the page
 * makes, and a caching rule that is one line too broad serves yesterday's HTML
 * to today's visitor, or answers a booking request out of a cache. Nothing in
 * the rest of the suite would notice — so it is executed here against a fake
 * global scope and asserted on by outcome.
 *
 * The two rules worth pinning: **the API is never intercepted** (it carries the
 * session, the subscriptions and every mutation, and a cached answer there is
 * indistinguishable from a booking that did not happen), and **HTML is never
 * cached** — offline falls back to a page that says so, rather than to a
 * dashboard belonging to whoever used this browser last.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

const ORIGIN = 'https://booker.example';

type Handler = (event: FakeEvent) => void;

interface FakeEvent {
  request: { method: string; url: string; mode?: string };
  respondWith: (response: Promise<unknown> | unknown) => void;
  waitUntil: (work: Promise<unknown>) => void;
}

/** A Cache that remembers what was put in it, keyed by URL like the real one. */
class FakeCache {
  readonly entries = new Map<string, unknown>();

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.entries.set(url, { cached: url });
  }

  async put(request: { url: string } | string, response: unknown): Promise<void> {
    this.entries.set(typeof request === 'string' ? request : request.url, response);
  }

  async match(request: { url: string } | string): Promise<unknown> {
    return this.entries.get(typeof request === 'string' ? request : request.url);
  }
}

let handlers: Record<string, Handler>;
let cacheStore: Map<string, FakeCache>;
let network: ReturnType<typeof vi.fn>;
let claimed: number;
let skipped: number;

/** Load sw.js into a scope that behaves enough like a ServiceWorkerGlobalScope. */
function loadWorker(): void {
  handlers = {};
  cacheStore = new Map();
  claimed = 0;
  skipped = 0;

  const caches = {
    async open(name: string): Promise<FakeCache> {
      const existing = cacheStore.get(name) ?? new FakeCache();
      cacheStore.set(name, existing);
      return existing;
    },
    async keys(): Promise<string[]> {
      return [...cacheStore.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return cacheStore.delete(name);
    },
    async match(request: { url: string } | string): Promise<unknown> {
      const key = typeof request === 'string' ? request : request.url;
      for (const cache of cacheStore.values()) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self = {
    addEventListener(type: string, handler: Handler) {
      handlers[type] = handler;
    },
    location: { origin: ORIGIN },
    clients: {
      async claim() {
        claimed += 1;
      },
    },
    async skipWaiting() {
      skipped += 1;
    },
  };

  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, network);
}

/** Dispatch an event and settle everything the worker asked to wait on. */
async function dispatch(
  type: string,
  request?: { method: string; url: string; mode?: string },
): Promise<{ responded: boolean; response: unknown }> {
  const waits: Array<Promise<unknown>> = [];
  let responded = false;
  let response: unknown;

  const event: FakeEvent = {
    request: request ?? { method: 'GET', url: `${ORIGIN}/` },
    respondWith(value) {
      responded = true;
      response = value;
    },
    waitUntil(work) {
      waits.push(work);
    },
  };

  handlers[type]?.(event);
  await Promise.all(waits);
  return { responded, response: await response };
}

const get = (path: string, mode = 'no-cors') => ({ method: 'GET', url: `${ORIGIN}${path}`, mode });
const navigate = (path: string) => get(path, 'navigate');

beforeEach(() => {
  network = vi.fn(async () => ({ ok: true, type: 'basic', from: 'network', clone: () => ({ copy: true }) }));
  loadWorker();
});

describe('installing', () => {
  it('precaches the offline page, so the fallback exists before it is needed', async () => {
    await dispatch('install');

    const cached = [...cacheStore.values()].flatMap((cache) => [...cache.entries.keys()]);
    expect(cached).toContain('/offline');
    expect(skipped).toBe(1);
  });
});

describe('activating', () => {
  it('deletes caches from a previous version and takes over open pages', async () => {
    cacheStore.set('elixia-shell-v0', new FakeCache());
    await dispatch('install');
    await dispatch('activate');

    expect([...cacheStore.keys()]).not.toContain('elixia-shell-v0');
    expect([...cacheStore.keys()].length).toBeGreaterThan(0);
    expect(claimed).toBe(1);
  });
});

describe('fetching', () => {
  it('never comes between the app and its own API', async () => {
    for (const path of ['/api/me', '/api/subscriptions', '/api/auth/session']) {
      const result = await dispatch('fetch', get(path));
      expect(result.responded, path).toBe(false);
    }
  });

  it('leaves anything that is not a plain GET alone', async () => {
    const result = await dispatch('fetch', { method: 'POST', url: `${ORIGIN}/api/subscriptions` });
    expect(result.responded).toBe(false);
  });

  it('leaves other origins alone', async () => {
    const result = await dispatch('fetch', { method: 'GET', url: 'https://elsewhere.example/x.js' });
    expect(result.responded).toBe(false);
  });

  it('serves pages from the network, and does not keep a copy', async () => {
    const result = await dispatch('fetch', navigate('/'));

    expect(result.responded).toBe(true);
    expect(result.response).toMatchObject({ from: 'network' });
    const cached = [...cacheStore.values()].flatMap((cache) => [...cache.entries.keys()]);
    expect(cached).not.toContain(`${ORIGIN}/`);
  });

  it('shows the offline page when a page cannot be reached', async () => {
    await dispatch('install');
    network.mockRejectedValueOnce(new Error('offline'));

    const result = await dispatch('fetch', navigate('/'));

    expect(result.response).toMatchObject({ cached: '/offline' });
  });

  it('serves a fingerprinted asset from cache once it has been seen', async () => {
    const asset = get('/_next/static/chunks/main-abc123.js');

    await dispatch('fetch', asset);
    expect(network).toHaveBeenCalledTimes(1);

    network.mockResolvedValue({ ok: true, type: 'basic', from: 'second-trip', clone: () => ({}) });
    const second = await dispatch('fetch', asset);

    expect(network).toHaveBeenCalledTimes(1);
    expect(second.response).toMatchObject({ copy: true });
  });

  it('does not cache an asset the server refused', async () => {
    network.mockResolvedValue({ ok: false, status: 404, type: 'basic', clone: () => ({ copy: true }) });

    await dispatch('fetch', get('/_next/static/chunks/missing.js'));

    const cached = [...cacheStore.values()].flatMap((cache) => [...cache.entries.keys()]);
    expect(cached).not.toContain(`${ORIGIN}/_next/static/chunks/missing.js`);
  });
});
