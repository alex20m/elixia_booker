// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardView } from '@/lib/service';

/**
 * Whether the dashboard shows who is running a class.
 *
 * The name comes and goes on its own nightly refresh (see `refreshInstructors`
 * in lib/service.ts), independently of anything the visitor does — so what
 * matters here is only that the dashboard renders whatever `/api/me` says, and
 * says nothing extra when there is nothing to say.
 */

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'u1' } }, isPending: false }),
    signOut: async () => {},
  },
}));

const { default: DashboardApp } = await import('@/app/DashboardApp');

let container: HTMLDivElement;
let root: Root;

const baseView: DashboardView = {
  account: {
    bookingWindowDays: 7,
    timeZone: 'Europe/Helsinki',
    notifyChannel: 'email',
    notifyEmail: 'alice@example.com',
    telegramChatId: '',
    elixiaEmail: 'alice@example.com',
    elixiaStatus: 'ok',
  },
  telegramConnect: true,
  subscriptions: [
    {
      id: 'sub-1',
      className: 'Bodypump',
      center: 'Tapiola',
      weekday: 'monday',
      startTime: '09:00',
      enabled: true,
      nextReleaseAt: null,
    },
  ],
  history: [],
  dryRun: false,
  apiDiscovered: true,
  mock: true,
  ephemeralStore: false,
} as unknown as DashboardView;

function stubFetch(view: DashboardView): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.startsWith('/api/me')) return new Response(JSON.stringify(view), { status: 200 });
      if (target.startsWith('/api/catalog')) {
        const center = new URL(target, 'http://x').searchParams.get('center');
        return new Response(
          JSON.stringify(center === null ? { centers: [] } : { classes: [] }),
          { status: 200 },
        );
      }
      if (target.startsWith('/api/preferences')) {
        return new Response(JSON.stringify({ defaults: { center: '' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stubMatchMedia();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('who is running the class', () => {
  it('shows the name the nightly refresh last found', async () => {
    stubFetch({
      ...baseView,
      subscriptions: [{ ...baseView.subscriptions[0]!, instructorName: 'Maija Meikäläinen' }],
    });

    await act(async () => {
      root.render(<DashboardApp />);
    });

    expect(container.textContent).toMatch(/Maija Meikäläinen/);
  });

  it('says nothing extra when no instructor has been found yet', async () => {
    // Absent, not a placeholder like "Unknown" — a class newly added, or one
    // whose centre could not be read last night, has no name to show yet.
    stubFetch(baseView);

    await act(async () => {
      root.render(<DashboardApp />);
    });

    const row = container.querySelector('#subs-list .row')!;
    expect(row.querySelector('.class-instructor')).toBeNull();
  });
});
