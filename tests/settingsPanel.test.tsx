// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from '@/app/DashboardApp';
import type { DashboardView } from '@/lib/service';

/**
 * The Settings panel, which is where a user says where their alerts go.
 *
 * Two things here are easy to get wrong and invisible when they are: a form
 * that posts a blank chat id disconnects a chat on every save, and a
 * deployment with no webhook configured has to keep offering the old manual
 * field or its users cannot use Telegram at all. Both are pinned below.
 */

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; method: string; body: unknown }>;
let opened: string[];

const view = (overrides: Partial<DashboardView['account']> = {}, telegramConnect = true): DashboardView =>
  ({
    account: {
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'email',
      notifyEmail: 'alice@example.com',
      telegramChatId: '',
      elixiaEmail: '',
      elixiaStatus: 'unlinked',
      ...overrides,
    },
    telegramConnect,
    subscriptions: [],
    history: [],
    dryRun: false,
    apiDiscovered: true,
    mock: true,
    ephemeralStore: false,
  }) as DashboardView;

const render = (dashboard: DashboardView): void => {
  act(() => {
    root.render(<Settings view={dashboard} refresh={async () => {}} />);
  });
};

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

const click = async (id: string): Promise<void> => {
  await act(async () => {
    byId<HTMLButtonElement>(id)!.click();
  });
};

const choose = async (id: string, value: string): Promise<void> => {
  const select = byId<HTMLSelectElement>(id)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  opened = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload =
      url === '/api/telegram/link'
        ? { url: 'https://t.me/elixia_booker_bot?start=abc', expiresAt: '2026-06-01T12:10:00Z' }
        : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch);

  vi.stubGlobal('open', (url: string) => {
    opened.push(url);
    return null;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Settings notifications', () => {
  it('asks for an address when alerts go by email', () => {
    render(view());

    expect(byId('notify-email')).not.toBeNull();
    expect(byId('tg-connect')).toBeNull();
  });

  it('offers the one-tap connect once Telegram is chosen', async () => {
    render(view());

    await choose('notify-channel', 'telegram');

    expect(byId('tg-connect')).not.toBeNull();
    expect(byId('notify-email')).toBeNull();
  });

  it('opens the link the server minted, rather than a page the user must read', async () => {
    render(view({ notifyChannel: 'telegram' }));

    await click('tg-connect');

    expect(requests).toContainEqual({
      url: '/api/telegram/link',
      method: 'POST',
      body: undefined,
    });
    expect(opened).toEqual(['https://t.me/elixia_booker_bot?start=abc']);
  });

  it('shows a connected chat, and offers to give it up', async () => {
    render(view({ notifyChannel: 'telegram', telegramChatId: '555' }));

    expect(container.textContent).toContain('555');

    await click('tg-disconnect');

    expect(requests).toContainEqual({
      url: '/api/telegram/link',
      method: 'DELETE',
      body: undefined,
    });
  });

  it('falls back to the manual chat id where no webhook is configured', () => {
    // Without it, a deployment that predates the connect flow — or one whose
    // operator has not set the webhook up — offers Telegram and then provides
    // no way to reach it.
    render(view({ notifyChannel: 'telegram' }, false));

    expect(byId('tg-connect')).toBeNull();
    expect(byId('tg')).not.toBeNull();
  });

  it('saves the channel and the address together', async () => {
    render(view());

    await click('save-btn');

    expect(requests[0]!.body).toMatchObject({
      notifyChannel: 'email',
      notifyEmail: 'alice@example.com',
    });
  });

  it('does not send a blank chat id, which would disconnect on every save', async () => {
    // The connected chat is not on this form at all; a save that posted an
    // empty string for it would silently undo the connect flow.
    render(view({ notifyChannel: 'telegram', telegramChatId: '555' }));

    await click('save-btn');

    expect(requests[0]!.body).not.toHaveProperty('telegramChatId');
  });

  it('still sends a hand-typed chat id where that is the only option', async () => {
    render(view({ notifyChannel: 'telegram', telegramChatId: '555' }, false));

    await click('save-btn');

    expect(requests[0]!.body).toMatchObject({ telegramChatId: '555' });
  });
});
