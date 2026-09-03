// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ElixiaLink } from '@/app/ElixiaLink';
import type { DashboardView } from '@/lib/service';

/**
 * The gym-account card: link an account, and — the reason this file exists —
 * correct the address or the password of the one already linked.
 *
 * Editing used to mean unlinking and linking again, which erases every booking
 * the cron had queued, so a typo in an email address cost a week of classes.
 * The properties pinned here are the ones that make the edit safe to reach for:
 * the address is offered already filled in, the password field is not (there is
 * nothing to fill it with that would not put the plaintext back on the wire),
 * a blank password means "keep the stored one", and a rejected edit leaves the
 * card showing the link that still works.
 */

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; method: string; body: unknown }>;
let refreshes: number;
/** What the next request answers with, so the failure path can be driven. */
let reply: { status: number; body: unknown };

const view = (overrides: Partial<DashboardView['account']> = {}): DashboardView =>
  ({
    account: {
      bookingWindowDays: 7,
      timeZone: 'Europe/Helsinki',
      notifyChannel: 'email',
      notifyEmail: 'alice@example.com',
      telegramChatId: '',
      elixiaEmail: 'gym@example.com',
      elixiaStatus: 'ok',
      ...overrides,
    },
    telegramConnect: true,
    emailConfigured: true,
    subscriptions: [],
    history: [],
    dryRun: false,
    apiDiscovered: true,
    mock: true,
    ephemeralStore: false,
  }) as DashboardView;

const render = (dashboard: DashboardView): void => {
  act(() => {
    root.render(
      <ElixiaLink
        view={dashboard}
        refresh={async () => {
          refreshes += 1;
        }}
      />,
    );
  });
};

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

const click = async (id: string): Promise<void> => {
  await act(async () => {
    byId<HTMLButtonElement>(id)!.click();
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  refreshes = 0;
  reply = { status: 200, body: { ok: true } };

  vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('linking a gym account', () => {
  it('asks for both fields when nothing is linked', async () => {
    render(view({ elixiaEmail: undefined, elixiaStatus: 'unlinked' }));

    await type('ex-email', 'gym@example.com');
    await type('ex-password', 'correct-horse');
    await click('link-btn');

    expect(requests).toEqual([
      {
        url: '/api/elixia',
        method: 'POST',
        body: { email: 'gym@example.com', password: 'correct-horse' },
      },
    ]);
    expect(refreshes).toBe(1);
  });

  it('offers the rejected address back when the saved credentials stopped working', async () => {
    // Re-linking after an expiry is nearly always the same account with a new
    // password, so making someone retype the address is pure friction.
    render(view({ elixiaStatus: 'expired' }));

    expect(byId<HTMLInputElement>('ex-email')!.value).toBe('gym@example.com');
    expect(byId<HTMLInputElement>('ex-password')!.value).toBe('');
  });
});

describe('editing the linked credentials', () => {
  it('offers an edit alongside unlink, rather than only unlink', async () => {
    render(view());

    expect(byId('edit-credentials-btn')).not.toBeNull();
    expect(byId('unlink-btn')).not.toBeNull();
  });

  it('opens the form with the current address filled in and the password blank', async () => {
    render(view());
    expect(byId('ex-email')).toBeNull();

    await click('edit-credentials-btn');

    expect(byId<HTMLInputElement>('ex-email')!.value).toBe('gym@example.com');
    expect(byId<HTMLInputElement>('ex-password')!.value).toBe('');
  });

  it('changes the address on its own, sending no password to fall back on the stored one', async () => {
    render(view());
    await click('edit-credentials-btn');

    await type('ex-email', 'moved@example.com');
    await click('save-credentials-btn');

    expect(requests).toEqual([
      {
        url: '/api/elixia',
        method: 'PATCH',
        body: { email: 'moved@example.com', password: '' },
      },
    ]);
    expect(refreshes).toBe(1);
  });

  it('changes the password on its own, keeping the address it was opened with', async () => {
    render(view());
    await click('edit-credentials-btn');

    await type('ex-password', 'new-passphrase');
    await click('save-credentials-btn');

    expect(requests[0]!.body).toEqual({ email: 'gym@example.com', password: 'new-passphrase' });
  });

  it('never unlinks on the way to an edit', async () => {
    // The whole point: DELETE erases the queued bookings.
    render(view());
    await click('edit-credentials-btn');
    await type('ex-password', 'new-passphrase');
    await click('save-credentials-btn');

    expect(requests.map((r) => r.method)).not.toContain('DELETE');
  });

  it('closes the form and forgets the typed password once the edit lands', async () => {
    render(view());
    await click('edit-credentials-btn');
    await type('ex-password', 'new-passphrase');
    await click('save-credentials-btn');

    expect(byId('ex-password')).toBeNull();
    await click('edit-credentials-btn');
    expect(byId<HTMLInputElement>('ex-password')!.value).toBe('');
  });

  it('keeps the form open and says why when Elixia refuses the new credentials', async () => {
    render(view());
    await click('edit-credentials-btn');
    await type('ex-password', 'wrong');

    reply = { status: 401, body: { error: 'Elixia rejected those credentials' } };
    await click('save-credentials-btn');

    expect(container.textContent).toContain('Elixia rejected those credentials');
    expect(byId('ex-password')).not.toBeNull();
    // Still the linked card, because the link that works was never touched.
    expect(byId('unlink-btn')).not.toBeNull();
    expect(refreshes).toBe(0);
  });

  it('drops the typed changes on cancel and clears the failure with them', async () => {
    render(view());
    await click('edit-credentials-btn');
    await type('ex-email', 'typo@example.com');

    reply = { status: 401, body: { error: 'Elixia rejected those credentials' } };
    await click('save-credentials-btn');
    await click('cancel-edit-btn');

    expect(byId('ex-email')).toBeNull();
    expect(container.textContent).not.toContain('Elixia rejected those credentials');

    await click('edit-credentials-btn');
    expect(byId<HTMLInputElement>('ex-email')!.value).toBe('gym@example.com');
  });

  it('still forgets the account entirely on unlink', async () => {
    render(view());

    await click('unlink-btn');

    expect(requests).toEqual([{ url: '/api/elixia', method: 'DELETE', body: undefined }]);
    expect(refreshes).toBe(1);
  });
});
