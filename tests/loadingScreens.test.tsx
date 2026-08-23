// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardView } from '@/lib/service';

/**
 * What the app shows while it is waiting.
 *
 * Every screen here is one a real visitor sits in front of on a phone on gym
 * wifi, and every one of them used to be a lie of some kind: a dashboard that
 * was blank until /api/me answered, a settings form whose Save button looked
 * unpressed for a second and accepted a second press, a class list whose
 * Remove sent two DELETEs to a double-tap.
 *
 * These tests are about what the visitor can tell. Not "a spinner exists"
 * — that assertion passes on a page that also lost its content — but: is the
 * app frame still there, does something say in words what is being waited for,
 * does content already on screen stay on screen, and does pressing twice send
 * one request.
 */

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'u1' } }, isPending: false }),
    signOut: async () => {},
  },
}));

const { default: DashboardApp } = await import('@/app/DashboardApp');
const { default: Setup } = await import('@/app/Setup');
const { default: AddClass } = await import('@/app/AddClass');
const { SettingsPanel } = await import('@/app/SettingsPanel');
const { default: RootLoading } = await import('@/app/loading');
const { default: AuthLoading } = await import('@/app/auth/[path]/loading');
const { default: AccountLoading } = await import('@/app/account/[path]/loading');

let container: HTMLDivElement;
let root: Root;
/** Requests seen, in order. */
let seen: Array<{ url: string; method: string }>;
/** URLs whose next response never arrives, so a wait can be looked at. */
let hang: Set<string>;

const VIEW: DashboardView = {
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

const SETUP_STATE = {
  needed: true,
  suggestedEmail: 'me@example.com',
  telegramConnect: true,
  telegramChatId: '',
};

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      seen.push({ url: target, method });

      if (hang.has(target)) return new Promise<Response>(() => {});

      if (target.startsWith('/api/me')) {
        return new Response(JSON.stringify(VIEW), { status: 200 });
      }
      if (target.startsWith('/api/setup')) {
        return new Response(JSON.stringify(SETUP_STATE), { status: 200 });
      }
      if (target.startsWith('/api/catalog')) {
        const center = new URL(target, 'http://x').searchParams.get('center');
        return new Response(
          JSON.stringify(
            center === null
              ? { centers: [{ id: '740', name: 'Tapiola' }] }
              : { classes: [{ className: 'Bodypump', weekday: 'monday', startTime: '09:00' }] },
          ),
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

/** jsdom has no matchMedia, and the theme control and install card both read it. */
function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const text = (): string => container.textContent ?? '';
const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

/** The one thing on a loading screen that assistive technology is given. */
const statusText = (): string =>
  [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

/** Set a <select> and let React see the change. */
const pick = async (id: string, value: string): Promise<void> => {
  const select = byId<HTMLSelectElement>(id)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const click = async (id: string): Promise<void> => {
  await act(async () => {
    byId<HTMLButtonElement>(id)!.click();
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  seen = [];
  hang = new Set();
  stubFetch();
  stubMatchMedia();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the dashboard, before it has loaded', () => {
  it('keeps the app frame and says what it is waiting for', async () => {
    hang.add('/api/me');

    await act(async () => {
      root.render(<DashboardApp />);
    });

    // The bar is the difference between "this app is fetching something" and
    // "this page failed to load".
    expect(container.querySelector('.appbar')).not.toBeNull();
    expect(statusText()).toMatch(/loading your account/i);
  });

  it('stands the coming page in, rather than showing an empty column', async () => {
    hang.add('/api/me');

    await act(async () => {
      root.render(<DashboardApp />);
    });

    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    // Placeholders are shape, not information: a screen reader that read them
    // out would hear a list of nothings.
    for (const block of container.querySelectorAll('.skeleton')) {
      expect(block.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});

describe('the dashboard, while it refreshes what is already on screen', () => {
  it('keeps the classes visible and marks the page busy, rather than blanking it', async () => {
    // Swapping a filled dashboard back to skeletons on every pause/remove reads
    // as the app having lost the data it just showed.
    await act(async () => {
      root.render(<DashboardApp />);
    });
    expect(text()).toContain('Bodypump');

    hang.add('/api/me');
    await click('pause-sub-1');

    expect(text()).toContain('Bodypump');
    expect(container.querySelector('.busybar.is-busy')).not.toBeNull();
  });

  it('sends one DELETE for a double-tapped Remove', async () => {
    await act(async () => {
      root.render(<DashboardApp />);
    });

    hang.add('/api/subscriptions/sub-1');
    await act(async () => {
      byId<HTMLButtonElement>('remove-sub-1')!.click();
      byId<HTMLButtonElement>('remove-sub-1')!.click();
    });

    const deletes = seen.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
  });
});

describe('the setup wizard, before it has loaded', () => {
  it('waits for the server rather than drawing a form it is about to change', async () => {
    // The wizard's email field is filled in from the account, and its Telegram
    // page depends on whether this deployment has a webhook. Drawing the form
    // first means drawing one that visibly rewrites itself a moment later.
    hang.add('/api/setup');

    await act(async () => {
      root.render(<Setup onDone={() => {}} />);
    });

    expect(statusText()).toMatch(/loading/i);
    expect(byId('setup-window')).toBeNull();
  });
});

describe('saving settings', () => {
  it('says it is saving, and sends one PUT for a double-press', async () => {
    hang.add('/api/settings');

    await act(async () => {
      root.render(<SettingsPanel view={VIEW} refresh={async () => {}} />);
    });

    await act(async () => {
      byId<HTMLButtonElement>('save-btn')!.click();
      byId<HTMLButtonElement>('save-btn')!.click();
    });

    expect(byId<HTMLButtonElement>('save-btn')!.disabled).toBe(true);
    expect(text()).toMatch(/saving/i);
    expect(seen.filter((r) => r.url === '/api/settings')).toHaveLength(1);
  });
});

describe('adding a class', () => {
  it('says which list it is fetching while the pickers are empty', async () => {
    hang.add('/api/catalog');

    await act(async () => {
      root.render(<AddClass refresh={async () => {}} />);
    });

    expect(text()).toMatch(/loading centres/i);
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('says it is adding, and sends one POST for a double-press', async () => {
    await act(async () => {
      root.render(<AddClass refresh={async () => {}} />);
    });

    // Centre, then class, then the slot within it — the three the chooser asks
    // for before Add becomes pressable at all.
    await pick('s-center', '740');
    await pick('s-class', 'Bodypump');
    await pick('s-slot', 'monday|09:00');

    hang.add('/api/subscriptions');
    await act(async () => {
      byId<HTMLButtonElement>('add-btn')!.click();
      byId<HTMLButtonElement>('add-btn')!.click();
    });

    expect(text()).toMatch(/adding/i);
    expect(seen.filter((r) => r.url === '/api/subscriptions')).toHaveLength(1);
  });
});

describe('the routes Next renders a loading state for', () => {
  // A navigation to /auth/sign-in or /account/security leaves the previous
  // screen frozen until the server answers. Next fills that gap from a
  // loading.tsx beside the page — and only if one exists, which is the whole
  // of what can go wrong here.
  const ROUTES: Array<[string, () => React.ReactNode, RegExp]> = [
    ['/', RootLoading, /loading booker/i],
    ['/auth/*', AuthLoading, /loading/i],
    ['/account/*', AccountLoading, /loading your account settings/i],
  ];

  for (const [route, Loading, says] of ROUTES) {
    it(`says what is coming while ${route} is still on its way`, async () => {
      await act(async () => {
        root.render(<>{Loading()}</>);
      });

      expect(statusText()).toMatch(says);
      expect(container.querySelector('.appbar')).not.toBeNull();
      expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });
  }

  it('keeps the way out of the account pages reachable while they load', async () => {
    // Back is the only exit from /account/*, and waiting for a page in order to
    // leave it is the state this avoids.
    await act(async () => {
      root.render(<>{AccountLoading()}</>);
    });

    expect(container.querySelector('.appbar a[href="/"]')).not.toBeNull();
  });
});
