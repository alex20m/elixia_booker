// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Setup from '@/app/Setup';

/**
 * The configuration pages a new account has to go through before the app will
 * show it anything.
 *
 * Two properties are what these tests exist for. **Nothing is preselected**:
 * every picker opens on a placeholder, and the button that would finish setup
 * stays disabled until each page has an answer — a wizard that arrives with 7
 * days and Europe/Helsinki already filled in is a default wearing a form's
 * clothes, and most people would click straight past it. And **the timezone is
 * picked, never typed**: there is no text input anywhere in this flow that
 * could accept "Europe/Helsinky".
 */

const STATE = {
  needed: true,
  suggestedEmail: 'me@example.com',
  telegramConnect: true,
  telegramChatId: '',
};

let container: HTMLDivElement;
let root: Root;
let posts: Array<{ url: string; body: unknown }>;
let state: typeof STATE;
let done: number;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (init?.method === 'POST' && target === '/api/setup') {
        posts.push({ url: target, body: JSON.parse(String(init.body)) });
        state = { ...state, needed: false };
        return new Response(JSON.stringify(state), { status: 200 });
      }
      if (init?.method === 'POST' && target === '/api/telegram/link') {
        posts.push({ url: target, body: null });
        // What tapping Start in Telegram eventually does, from this side.
        state = { ...state, telegramChatId: '4242' };
        return new Response(JSON.stringify({ url: 'https://t.me/bot?start=tok' }), { status: 200 });
      }
      if (init?.method === 'POST' && target === '/api/elixia') {
        const parsed = JSON.parse(String(init.body)) as { email: string; password: string };
        posts.push({ url: target, body: parsed });
        if (parsed.password === 'wrong') {
          return new Response(JSON.stringify({ error: 'Elixia rejected those credentials' }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(state), { status: 200 });
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posts = [];
  done = 0;
  state = { ...STATE };
  stubFetch();
  vi.stubGlobal('open', vi.fn());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <Setup
        onDone={() => {
          done += 1;
        }}
      />,
    );
  });
}

const el = <T extends HTMLElement>(id: string): T => {
  const found = container.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`no #${id} on this page`);
  return found;
};

const maybe = (id: string): HTMLElement | null => container.querySelector(`#${id}`);

async function choose(id: string, value: string): Promise<void> {
  await act(async () => {
    const select = el<HTMLSelectElement>(id);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = el<HTMLInputElement>(id);
    // What React listens for; setting .value alone updates nothing.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(id: string): Promise<void> {
  await act(async () => {
    el<HTMLButtonElement>(id).click();
  });
}

const disabled = (id: string): boolean => el<HTMLButtonElement>(id).disabled;

/** Answer the first two pages, leaving the wizard on notifications. */
async function throughToNotifications(): Promise<void> {
  await render();
  await choose('setup-window', '14');
  await click('setup-next');
  await choose('setup-tz', 'Europe/Stockholm');
  await click('setup-next');
}

/** Answer the first three pages, leaving the wizard on the gym account page. */
async function throughToGymAccount(): Promise<void> {
  await throughToNotifications();
  await choose('setup-channel', 'email');
  await type('setup-email', 'alerts@example.com');
  await click('setup-next');
}

describe('the membership page', () => {
  it('opens with nothing chosen and refuses to move on', async () => {
    await render();

    expect(el<HTMLSelectElement>('setup-window').value).toBe('');
    expect(disabled('setup-next')).toBe(true);

    await choose('setup-window', '7');
    expect(disabled('setup-next')).toBe(false);
  });

  it('offers both tiers and no third option to invent one', async () => {
    await render();
    const values = [...el<HTMLSelectElement>('setup-window').options].map((o) => o.value);

    expect(values).toEqual(['', '7', '14']);
  });
});

describe('the timezone page', () => {
  it('is a picker, with no way to type a zone by hand', async () => {
    await render();
    await choose('setup-window', '7');
    await click('setup-next');

    expect(el('setup-tz').tagName).toBe('SELECT');
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0);
    expect(el<HTMLSelectElement>('setup-tz').value).toBe('');
    expect(disabled('setup-next')).toBe(true);
  });

  it('offers the zones the app actually accepts, grouped so they can be found', async () => {
    await render();
    await choose('setup-window', '7');
    await click('setup-next');

    const values = [...el<HTMLSelectElement>('setup-tz').options].map((o) => o.value);
    expect(values).toContain('Europe/Helsinki');
    expect(values).toContain('Europe/Stockholm');
    expect(container.querySelectorAll('#setup-tz optgroup').length).toBeGreaterThan(1);
  });

  it('keeps the answer to the page before it when stepping back', async () => {
    await render();
    await choose('setup-window', '14');
    await click('setup-next');
    await click('setup-back');

    expect(el<HTMLSelectElement>('setup-window').value).toBe('14');
  });
});

describe('the notifications page', () => {
  it('opens with no channel chosen, and cannot move on that way', async () => {
    await throughToNotifications();

    expect(el<HTMLSelectElement>('setup-channel').value).toBe('');
    expect(disabled('setup-next')).toBe(true);
    expect(maybe('setup-email')).toBeNull();
  });

  it('suggests the signed-in address once email is chosen, and lets it be changed', async () => {
    await throughToNotifications();
    await choose('setup-channel', 'email');

    expect(el<HTMLInputElement>('setup-email').value).toBe('me@example.com');
    expect(disabled('setup-next')).toBe(false);

    await type('setup-email', '');
    expect(disabled('setup-next')).toBe(true);
  });

  it('will not move on with Telegram until a chat is actually connected', async () => {
    await throughToNotifications();
    await choose('setup-channel', 'telegram');

    expect(disabled('setup-next')).toBe(true);

    await click('tg-connect');
    // Still not connected: the deep link has opened, nobody has tapped Start.
    expect(disabled('setup-next')).toBe(true);

    await click('tg-check');
    expect(container.textContent).toMatch(/4242/);
    expect(disabled('setup-next')).toBe(false);
  });

  it('lets someone switch notifications off, and says what that costs', async () => {
    await throughToNotifications();
    await choose('setup-channel', 'none');

    expect(disabled('setup-next')).toBe(false);
    expect(container.textContent).toMatch(/will not be told/i);
  });
});

describe('the gym account page', () => {
  it('opens with nothing entered and refuses to finish that way', async () => {
    await throughToGymAccount();

    expect(el<HTMLInputElement>('setup-elixia-email').value).toBe('');
    expect(el<HTMLInputElement>('setup-elixia-password').value).toBe('');
    expect(disabled('setup-finish')).toBe(true);
  });

  it('stays disabled until both the email and the password are filled in', async () => {
    await throughToGymAccount();

    await type('setup-elixia-email', 'me@elixia.example');
    expect(disabled('setup-finish')).toBe(true);

    await type('setup-elixia-password', 'hunter2');
    expect(disabled('setup-finish')).toBe(false);

    await type('setup-elixia-email', '');
    expect(disabled('setup-finish')).toBe(true);
  });

  it('is a real password field, not plain text', async () => {
    await throughToGymAccount();

    expect(el<HTMLInputElement>('setup-elixia-password').type).toBe('password');
  });
});

describe('finishing', () => {
  it('submits exactly the answers that were given, including the gym account', async () => {
    await throughToGymAccount();
    await type('setup-elixia-email', 'me@elixia.example');
    await type('setup-elixia-password', 'hunter2');
    await click('setup-finish');

    expect(posts).toEqual([
      {
        url: '/api/setup',
        body: {
          bookingWindowDays: 14,
          timeZone: 'Europe/Stockholm',
          notifyChannel: 'email',
          notifyEmail: 'alerts@example.com',
        },
      },
      {
        url: '/api/elixia',
        body: { email: 'me@elixia.example', password: 'hunter2' },
      },
    ]);
    expect(done).toBe(1);
  });

  it('shows the server\'s reason and stays put when the setup submission is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === 'POST' && String(url) === '/api/setup'
          ? new Response(JSON.stringify({ error: 'Pick a timezone from the list' }), {
              status: 400,
            })
          : new Response(JSON.stringify(state), { status: 200 }),
      ),
    );

    await throughToNotifications();
    await choose('setup-channel', 'email');
    await click('setup-next');
    await type('setup-elixia-email', 'me@elixia.example');
    await type('setup-elixia-password', 'hunter2');
    await click('setup-finish');

    expect(container.textContent).toMatch(/Pick a timezone from the list/);
    expect(done).toBe(0);
    // Still on the page it failed from, with the answers intact.
    expect(el<HTMLInputElement>('setup-elixia-email').value).toBe('me@elixia.example');
  });

  it('shows Elixia\'s rejection and stays put without finishing, even though setup was saved', async () => {
    await throughToGymAccount();
    await type('setup-elixia-email', 'me@elixia.example');
    await type('setup-elixia-password', 'wrong');
    await click('setup-finish');

    expect(container.textContent).toMatch(/Elixia rejected those credentials/);
    expect(done).toBe(0);
    expect(posts.map((p) => p.url)).toEqual(['/api/setup', '/api/elixia']);
    // The answers are kept, so correcting the password does not mean redoing the wizard.
    expect(el<HTMLInputElement>('setup-elixia-email').value).toBe('me@elixia.example');
  });
});
