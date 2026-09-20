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
  firstAttemptOutcome: null,
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

/**
 * The row's three lines, read separately.
 *
 * Deliberately not one `textContent`: that concatenates the lines with no
 * separator, so "1 try" runs straight into the outcome pill and an assertion
 * about a word ending cannot be written. Reading each line also keeps the
 * split itself under test — which fact is on which line is the point here.
 */
const renderRow = async (
  entry: BookingHistoryEntry,
): Promise<{ title: string; meta: string; timing: string }> => {
  stubFetch(viewWith([entry]));
  await act(async () => {
    root.render(<DashboardApp />);
  });
  const row = container.querySelector('#history-list .row');
  if (!row) throw new Error('no history row rendered');
  const text = (selector: string): string =>
    row.querySelector(selector)?.textContent ?? '';
  return { title: text('.row-title'), meta: text('.row-meta'), timing: text('.row-timing') };
};

describe('the Activity tab', () => {
  it('says how many tries an attempt took', async () => {
    // Several tries means the class was not listed at the computed instant
    // and the run spent rounds waiting for it — a completely different cause
    // from one slow try, and invisible without this number.
    expect((await renderRow(attempt({ attempts: 4 }))).timing).toMatch(/\b4 tries\b/);
  });

  it('says one try in the singular, so a clean run reads as one', async () => {
    // Shown even at one: absent, a reader cannot tell "it went first time"
    // from "this build does not report it".
    const { timing } = await renderRow(attempt({ attempts: 1 }));
    expect(timing).toMatch(/\b1 try\b/);
    expect(timing).not.toMatch(/1 tries/);
  });

  it('separates when the run woke from when the request went out', async () => {
    // The gap between them is the critical path. One number alone reads as
    // if the booking happened the instant the window opened.
    const { timing } = await renderRow(
      attempt({ firstAttemptOffsetMs: 1, bookRequestOffsetMs: 910 }),
    );
    expect(timing).toContain('woke +1ms');
    expect(timing).toContain('sent +910ms');
  });

  it('shows how long the run spent between waking and asking', async () => {
    // The gap is the critical path, and it is the answer to "why was mine
    // slower" — subtracting two offsets by eye is exactly the step someone
    // will not take.
    const { timing } = await renderRow(
      attempt({ firstAttemptOffsetMs: 1, bookRequestOffsetMs: 112 }),
    );
    expect(timing).toContain('111ms finding the class');
  });

  it('says a row predates the request time rather than implying it was instant', async () => {
    const { timing } = await renderRow(attempt({ bookRequestOffsetMs: undefined }));
    expect(timing).toContain('woke +1ms');
    expect(timing).toContain('request time not recorded');
    expect(timing).not.toMatch(/sent \+\d/);
  });

  it('says no request went out when the class never listed', async () => {
    // Distinct from an old row: nothing was ever sent, rather than a time
    // that was not saved. Reading one as the other sends someone hunting a
    // slow request that never happened.
    const { timing } = await renderRow(
      attempt({ outcome: 'too-early', attempts: 12, bookRequestOffsetMs: null }),
    );
    expect(timing).toMatch(/\b12 tries\b/);
    expect(timing).toContain('no request sent');
    expect(timing).not.toContain('request time not recorded');
    expect(timing).not.toMatch(/sent \+\d/);
  });

  it('says how the first try was refused, so the tries count means something', async () => {
    // Without it, "4 tries" is a number with no cause attached — and the two
    // causes want opposite responses: a 4xx is the window not quite open, a
    // rejected session is a broken account.
    const { timing } = await renderRow(
      attempt({ attempts: 4, firstAttemptOutcome: 'error 400' }),
    );
    expect(timing).toContain('first: error 400');
  });

  it('says nothing about the first try when it was also the last', async () => {
    const { timing } = await renderRow(attempt({ attempts: 1, firstAttemptOutcome: null }));
    expect(timing).toMatch(/\b1 try\b/);
    expect(timing).not.toContain('first:');
  });

  it('keeps the technical timings off the line a person reads first', async () => {
    // The split the notifications rely on: line two is what happened, line
    // three is the machinery. A reader who does not care can stop at two.
    const { meta, timing } = await renderRow(attempt({ detail: 'waitlist position 16' }));
    expect(meta).toContain('waitlist position 16');
    expect(meta).not.toContain('woke');
    expect(meta).not.toContain('try');
    expect(timing).toContain('woke +1ms');
  });
});
