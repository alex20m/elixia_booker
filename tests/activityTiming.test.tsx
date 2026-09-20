// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardView } from '@/lib/service';
import type { BookingHistoryEntry } from '@/lib/types';

/**
 * What the Activity tab has to say about *why* an attempt landed where it did.
 *
 * This is the page someone opens after a booking came back 16th on a waiting
 * list when a friend's came back 5th, so it has to carry the three facts that
 * separate those two runs: how many tries it took, when the run woke, and when
 * the booking request actually went out. The tab was called "Recent attempts"
 * while showing neither the attempt count nor the request time — and printing
 * the wake-up offset in a way that read as the booking.
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

const attempt = (over: Partial<BookingHistoryEntry> = {}): BookingHistoryEntry => ({
  atMs: Date.UTC(2026, 8, 6, 6, 0),
  subscriptionId: 'sub-1',
  className: 'Bodypump',
  classDate: '2026-09-13',
  startTime: '09:00',
  outcome: 'waitlisted',
  attempts: 1,
  firstAttemptOffsetMs: 1,
  bookRequestOffsetMs: 910,
  dryRun: false,
  ...over,
});

const viewWith = (history: BookingHistoryEntry[]): DashboardView =>
  ({
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
    subscriptions: [],
    history,
    dryRun: false,
    apiDiscovered: true,
    mock: true,
    ephemeralStore: false,
  }) as unknown as DashboardView;

function stubFetch(view: DashboardView): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.startsWith('/api/me')) return new Response(JSON.stringify(view), { status: 200 });
      if (target.startsWith('/api/catalog')) {
        const center = new URL(target, 'http://x').searchParams.get('center');
        return new Response(JSON.stringify(center === null ? { centers: [] } : { classes: [] }), {
          status: 200,
        });
      }
      if (target.startsWith('/api/preferences')) {
        return new Response(JSON.stringify({ defaults: { center: '' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.history.replaceState(null, '', '/?tab=activity');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const renderRow = async (entry: BookingHistoryEntry): Promise<string> => {
  stubFetch(viewWith([entry]));
  await act(async () => {
    root.render(<DashboardApp />);
  });
  const row = container.querySelector('#history-list .row');
  if (!row) throw new Error('no history row rendered');
  return row.textContent ?? '';
};

describe('the Activity tab', () => {
  it('says how many tries an attempt took', async () => {
    // Several tries means the class was not listed at the computed instant
    // and the run spent rounds waiting for it — a completely different cause
    // from one slow try, and invisible without this number.
    expect(await renderRow(attempt({ attempts: 4 }))).toMatch(/4 tries/);
  });

  it('says one try in the singular, so a clean run reads as one', async () => {
    // Shown even at one: absent, a reader cannot tell "it went first time"
    // from "this build does not report it".
    const text = await renderRow(attempt({ attempts: 1 }));
    expect(text).toMatch(/1 try\b/);
    expect(text).not.toMatch(/1 tries/);
  });

  it('separates when the run woke from when the request went out', async () => {
    // The gap between them is the critical path. One number alone reads as
    // if the booking happened the instant the window opened.
    const text = await renderRow(attempt({ firstAttemptOffsetMs: 1, bookRequestOffsetMs: 910 }));
    expect(text).toContain('woke +1ms');
    expect(text).toContain('sent +910ms');
  });

  it('claims nothing about the request on a row written before it was recorded', async () => {
    const text = await renderRow(attempt({ bookRequestOffsetMs: undefined }));
    expect(text).toContain('woke +1ms');
    expect(text).not.toContain('sent');
  });

  it('claims nothing about the request when the class never listed', async () => {
    // Distinct from an old row: nothing was ever sent, so there is no
    // offset to show rather than one that was not saved.
    const text = await renderRow(
      attempt({ outcome: 'too-early', attempts: 12, bookRequestOffsetMs: null }),
    );
    expect(text).toMatch(/12 tries/);
    expect(text).not.toContain('sent');
  });
});
