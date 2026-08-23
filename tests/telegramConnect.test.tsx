// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TelegramConnect,
  TELEGRAM_POLL_MS,
  TELEGRAM_WATCH_FALLBACK_MS,
  watchDeadline,
} from '@/app/components/TelegramConnect';

/**
 * The Connect-Telegram control, which is the one place in this app where the
 * thing the user is waiting for happens in another app entirely.
 *
 * The tap lands on the webhook, not in this page, so the page only learns about
 * it by asking again. It used to ask only when the user pressed "check again",
 * which meant the common outcome of a successful connection was a screen that
 * still said "tap Start" — indistinguishable from a failed one. So what these
 * tests pin is that the asking is automatic: it happens on its own while the
 * wait is on, it happens immediately when the user comes back to the tab, it
 * does not happen while the tab is hidden or after the chat is connected, and
 * it stops when the link the server minted can no longer work.
 */

let container: HTMLDivElement;
let root: Root;
let checks: number;
let failChecks: number;
let tapped: boolean;
let errors: string[];
let opened: string[];
let disconnects: number;
let expiresAt: string | undefined;
let linkStatus: number;

/**
 * A host that owns the chat id, the way both real screens do: `check` is what
 * asking the server looks like from here, and it only produces a chat id once
 * `tapped` says the user has tapped Start in Telegram.
 */
function Host({ withDisconnect = false }: { withDisconnect?: boolean }) {
  const [chatId, setChatId] = useState('');
  return (
    <TelegramConnect
      chatId={chatId}
      check={async () => {
        checks += 1;
        if (failChecks > 0) {
          failChecks -= 1;
          throw new Error('network is down');
        }
        if (tapped) setChatId('4242');
      }}
      onError={(message) => errors.push(message)}
      onDisconnect={
        withDisconnect
          ? async () => {
              disconnects += 1;
              setChatId('');
            }
          : undefined
      }
    />
  );
}

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

const click = async (id: string): Promise<void> => {
  await act(async () => {
    byId<HTMLButtonElement>(id)!.click();
  });
};

/** Let real time pass, as far as the page is concerned. */
const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const setHidden = async (hidden: boolean): Promise<void> => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const render = async (props: { withDisconnect?: boolean } = {}): Promise<void> => {
  await act(async () => {
    root.render(<Host {...props} />);
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  checks = 0;
  failChecks = 0;
  tapped = false;
  errors = [];
  opened = [];
  disconnects = 0;
  linkStatus = 200;
  // Ten minutes out, as the server mints it.
  expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (linkStatus !== 200) {
        return new Response(JSON.stringify({ error: 'Telegram is not configured' }), {
          status: linkStatus,
        });
      }
      return new Response(JSON.stringify({ url: 'https://t.me/bot?start=tok', expiresAt }), {
        status: 200,
      });
    }),
  );
  vi.stubGlobal('open', (url: string) => {
    opened.push(url);
    return null;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('connecting a Telegram chat', () => {
  it('opens the link the server minted and says the page is watching for the tap', async () => {
    await render();

    await click('tg-connect');

    expect(opened).toEqual(['https://t.me/bot?start=tok']);
    expect(byId('tg-status')!.textContent).toMatch(/waiting/i);
    // The point of the whole change: nobody should be looking for a refresh.
    expect(byId('tg-status')!.textContent).toMatch(/on its own|by itself/i);
  });

  it('shows the connected chat without anyone pressing anything', async () => {
    await render();
    await click('tg-connect');
    tapped = true;

    await wait(TELEGRAM_POLL_MS);

    expect(byId('tg-connected')!.textContent).toContain('4242');
    expect(byId('tg-connect')).toBeNull();
    expect(byId('tg-status')).toBeNull();
  });

  it('stops asking once the chat is connected', async () => {
    await render();
    await click('tg-connect');
    tapped = true;
    await wait(TELEGRAM_POLL_MS);

    const settled = checks;
    await wait(TELEGRAM_POLL_MS * 5);

    expect(checks).toBe(settled);
  });

  it('checks the moment the user comes back from Telegram, without waiting for the next poll', async () => {
    await render();
    await click('tg-connect');

    await setHidden(true);
    await wait(TELEGRAM_POLL_MS * 3);
    // A backgrounded tab is where this page spends the whole wait, and its
    // timers are throttled anyway — asking into it buys nothing.
    expect(checks).toBe(0);

    tapped = true;
    await setHidden(false);

    expect(byId('tg-connected')!.textContent).toContain('4242');
  });

  it('gives up when the minted link can no longer work, and offers a fresh one', async () => {
    await render();
    await click('tg-connect');

    await wait(10 * 60_000 + TELEGRAM_POLL_MS);

    expect(byId('tg-status')!.textContent).toMatch(/expired|no longer/i);
    expect(byId('tg-connect')).not.toBeNull();

    // A dead token is not worth polling for; the next attempt mints a new one.
    const abandoned = checks;
    await wait(TELEGRAM_POLL_MS * 5);
    expect(checks).toBe(abandoned);
  });

  it('still lets an impatient user ask right now', async () => {
    await render();
    await click('tg-connect');
    tapped = true;

    await click('tg-check');

    expect(byId('tg-connected')!.textContent).toContain('4242');
  });

  it('keeps waiting when a check fails, because a failed request is not a failed connection', async () => {
    await render();
    await click('tg-connect');
    // The next two polls throw — a phone changing networks mid-tap. A watch
    // that gave up on the first one would leave the page saying "waiting"
    // forever while asking nothing.
    failChecks = 2;

    await wait(TELEGRAM_POLL_MS * 2);
    expect(byId('tg-status')!.textContent).toMatch(/waiting/i);
    expect(errors).toEqual([]);

    tapped = true;
    await wait(TELEGRAM_POLL_MS);

    expect(byId('tg-connected')!.textContent).toContain('4242');
  });

  it('reports a link that could not be minted, and does not pretend to be waiting', async () => {
    linkStatus = 500;
    await render();

    await click('tg-connect');

    expect(errors).toEqual(['Telegram is not configured']);
    expect(byId('tg-status')!.textContent).toBe('');
    expect(opened).toEqual([]);
  });

  it('stops watching when the chat is given up', async () => {
    await render({ withDisconnect: true });
    await click('tg-connect');
    tapped = true;
    await wait(TELEGRAM_POLL_MS);

    await click('tg-disconnect');
    expect(disconnects).toBe(1);

    const settled = checks;
    await wait(TELEGRAM_POLL_MS * 5);
    expect(checks).toBe(settled);
    expect(byId('tg-status')!.textContent).toBe('');
  });
});

describe('how long the page is willing to wait', () => {
  it('waits exactly as long as the server says the link lives', () => {
    const now = 1_700_000_000_000;
    expect(watchDeadline(new Date(now + 90_000).toISOString(), now)).toBe(now + 90_000);
  });

  it('falls back to the advertised ten minutes when the server said nothing usable', () => {
    const now = 1_700_000_000_000;
    expect(watchDeadline(undefined, now)).toBe(now + TELEGRAM_WATCH_FALLBACK_MS);
    expect(watchDeadline('not a date', now)).toBe(now + TELEGRAM_WATCH_FALLBACK_MS);
  });

  it('does not end the wait before it starts when the browser clock runs ahead', () => {
    // Two clocks, and only one of them is the server's. An expiry that has
    // already passed says more about this browser than about the token.
    const now = 1_700_000_000_000;
    expect(watchDeadline(new Date(now - 30_000).toISOString(), now)).toBe(
      now + TELEGRAM_WATCH_FALLBACK_MS,
    );
  });
});
