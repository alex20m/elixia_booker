import { describe, expect, it, vi } from 'vitest';

/**
 * /api/catalog is what the class chooser is built from, and its whole value is
 * that it answers from the live schedule every time. A cached answer would go
 * stale in both directions: a centre or class added since the last request
 * would be missing, and one that has been withdrawn would still be offered.
 *
 * Auth and the Elixia session are stubbed — neither exists in a test process —
 * but the route's own code runs for real, and the assertions are on the
 * Response it actually builds.
 */

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  requireUser: async () => ({ config: {}, profile: {}, nowMs: 0 }),
}));

vi.mock('@/lib/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/service')>()),
  listCenters: async () => [{ id: '741', name: 'Circus' }],
  listClasses: async (_config: unknown, _profile: unknown, center: string) => [
    { className: `class at ${center}`, weekday: 'monday', startTime: '09:00' },
  ],
}));

const { GET, dynamic } = await import('@/app/api/catalog/route');

const call = (url: string): Promise<Response> => GET(new Request(url));

describe('/api/catalog', () => {
  it('answers with the centre list when no centre is named', async () => {
    const body = (await (await call('http://x/api/catalog')).json()) as {
      centers: Array<{ name: string }>;
    };
    expect(body.centers).toEqual([{ id: '741', name: 'Circus' }]);
  });

  it('answers with that centre\'s classes when one is named', async () => {
    const body = (await (await call('http://x/api/catalog?center=741')).json()) as {
      classes: Array<{ className: string }>;
    };
    expect(body.classes[0]?.className).toBe('class at 741');
  });

  it('is never cached, at any layer', async () => {
    // force-dynamic keeps Vercel's CDN out of it; no-store keeps the browser
    // and any proxy out. Either one alone leaves a stale list possible.
    expect(dynamic).toBe('force-dynamic');
    expect((await call('http://x/api/catalog')).headers.get('cache-control')).toBe('no-store');
  });
});
