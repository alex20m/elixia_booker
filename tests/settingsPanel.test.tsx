// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsPanel } from '@/app/SettingsPanel';
import { TELEGRAM_POLL_MS } from '@/app/components/TelegramConnect';
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

const view = (
  overrides: Partial<DashboardView['account']> = {},
  telegramConnect = true,
  emailConfigured = true,
): DashboardView =>
  ({
    account: {
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'email',
      notifyEmail: 'alice@example.com',
      telegramChatId: '',
      elixiaEmail: '',
      elixiaStatus: 'unlinked',
      calendarSyncEnabled: false,
      calendarFeedToken: '',
      ...overrides,
    },
    telegramConnect,
    emailConfigured,
    subscriptions: [],
    history: [],
    dryRun: false,
    apiDiscovered: true,
    mock: true,
    ephemeralStore: false,
  }) as DashboardView;

const render = (dashboard: DashboardView, refresh: () => Promise<void> = async () => {}): void => {
  act(() => {
    root.render(<SettingsPanel view={dashboard} refresh={refresh} />);
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

const type = async (id: string, value: string): Promise<void> => {
  const input = byId<HTMLInputElement>(id)!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const label = (id: string): string => byId(id)!.textContent!;

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
        ? {
            url: 'https://t.me/elixia_booker_bot?start=abc',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          }
        : url === '/api/calendar' && init?.method !== 'DELETE'
          ? { enabled: true, token: 'cal-tok' }
          : url === '/api/calendar'
            ? { enabled: false }
            : url === '/api/notify/test'
              ? { sent: true }
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

  it('re-checks on its own after the link is opened, so nobody has to reload', async () => {
    // The tap lands on the webhook, not in this tab. Before this, the panel
    // only found out when the user pressed "check again" — so the ordinary
    // outcome of a successful connect was a page still asking for it.
    vi.useFakeTimers();
    try {
      let refreshes = 0;
      render(view({ notifyChannel: 'telegram' }), async () => {
        refreshes += 1;
      });

      await click('tg-connect');
      expect(refreshes).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TELEGRAM_POLL_MS * 2);
      });

      expect(refreshes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('is a timezone picker, not a box to mistype a zone into', async () => {
    // The old text field accepted "Europe/Helsinky" and every other near-miss,
    // and a wrong zone books at the wrong minute for as long as nobody looks.
    render(view());

    const zone = byId<HTMLSelectElement>('tz')!;
    expect(zone.tagName).toBe('SELECT');
    expect([...zone.options].map((o) => o.value)).toContain('Europe/Stockholm');
    expect(zone.value).toBe('Europe/Helsinki');
  });

  it('warns when Telegram is chosen but no chat is connected', async () => {
    // Disconnecting no longer moves anyone to email, so this is the state a
    // user can genuinely be left in — and being left in it silently is exactly
    // the failure: they believe they are covered and hear nothing.
    render(view({ notifyChannel: 'telegram', telegramChatId: '' }));

    expect(container.textContent).toMatch(/not being delivered/i);
  });

  it('says nothing of the sort once the chat is connected', async () => {
    render(view({ notifyChannel: 'telegram', telegramChatId: '555' }));

    expect(container.textContent).not.toMatch(/not being delivered/i);
  });

  it('warns when email is chosen but this deployment cannot send it', async () => {
    // Nothing gates the email option the way canConnect gates Telegram's
    // one-tap flow, so a deployment with no Resend key or verified sender
    // still offers it — and a user who picks it deserves the same "this is
    // not actually working" the Telegram banner already gives, rather than a
    // silence indistinguishable from every alert simply not having fired yet.
    render(view({ notifyChannel: 'email' }, true, false));

    expect(container.textContent).toMatch(/not being delivered/i);
  });

  it('says nothing of the sort once the deployment can send email', async () => {
    render(view({ notifyChannel: 'email' }, true, true));

    expect(container.textContent).not.toMatch(/not being delivered/i);
  });

  it('sends a test alert and reports that it arrived', async () => {
    render(view());

    await click('test-notify-btn');

    expect(requests).toContainEqual({
      url: '/api/notify/test',
      method: 'POST',
      body: undefined,
    });
    expect(byId('test-notify-result')!.textContent).toMatch(/sent/i);
  });

  it('reports why a test alert did not go through, instead of just saying it failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      requests.push({ url, method: 'POST', body: undefined });
      return new Response(
        JSON.stringify({ sent: false, reason: 'no Resend API key configured' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    render(view());

    await click('test-notify-btn');

    expect(byId('test-notify-result')!.textContent).toMatch(/no Resend API key configured/);
  });

  it('offers no test button once notifications are switched off', () => {
    render(view({ notifyChannel: 'none' }));

    expect(byId('test-notify-btn')).toBeNull();
  });
});

describe('Settings save button', () => {
  it('stops saying "Saved" once the channel is changed again', async () => {
    // The acknowledgement used to stick for the life of the panel, so a user
    // who saved, then switched channel, was looking at a button that claimed
    // their unsaved choice was already stored — and walked away from it.
    render(view());

    await click('save-btn');
    expect(label('save-btn')).toBe('Saved');

    await choose('notify-channel', 'none');

    expect(label('save-btn')).toBe('Save settings');
  });

  it('stops saying "Saved" once the address is edited again', async () => {
    render(view());

    await click('save-btn');
    expect(label('save-btn')).toBe('Saved');

    await type('notify-email', 'bob@example.com');

    expect(label('save-btn')).toBe('Save settings');
  });

  it('saves once when the button is pressed again mid-request', async () => {
    // Two PUTs for one intent, and the second raced the refresh the first
    // triggered. An impatient second press on a slow connection is the normal
    // way to get here, not an edge case.
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      await pending;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch);

    render(view());

    await click('save-btn');
    expect(label('save-btn')).toBe('Saving…');

    await click('save-btn');

    await act(async () => {
      finish();
      await pending;
    });

    expect(requests.filter((r) => r.url === '/api/settings')).toHaveLength(1);
    expect(label('save-btn')).toBe('Saved');
  });
});

describe('Settings calendar', () => {
  it('offers a single button to turn sync on when it is off', () => {
    render(view());

    expect(byId('calendar-enable')).not.toBeNull();
    expect(byId('calendar-webcal')).toBeNull();
  });

  it('turns sync on in one tap and hands off to the calendar app', async () => {
    render(view());

    await click('calendar-enable');

    expect(requests).toContainEqual({ url: '/api/calendar', method: 'POST', body: {} });
    expect(byId<HTMLAnchorElement>('calendar-webcal')!.href).toContain('cal-tok');
  });

  it('shows the existing link, and can turn sync back off', async () => {
    render(view({ calendarSyncEnabled: true, calendarFeedToken: 'existing-tok' }));

    expect(byId<HTMLAnchorElement>('calendar-webcal')!.href).toContain('existing-tok');

    await click('calendar-disable');

    expect(requests).toContainEqual({ url: '/api/calendar', method: 'DELETE', body: undefined });
    expect(byId('calendar-enable')).not.toBeNull();
  });

  it('can mint a fresh link without losing sync', async () => {
    render(view({ calendarSyncEnabled: true, calendarFeedToken: 'old-tok' }));

    await click('calendar-regenerate');

    expect(requests).toContainEqual({
      url: '/api/calendar',
      method: 'POST',
      body: { regenerate: true },
    });
    expect(byId<HTMLAnchorElement>('calendar-webcal')!.href).toContain('cal-tok');
  });

  it('copies the link to the clipboard without ever showing the raw token on screen', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(view({ calendarSyncEnabled: true, calendarFeedToken: 'existing-tok' }));
    await click('calendar-copy');

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('existing-tok'));
    expect(byId('calendar-url')).toBeNull();
  });
});
