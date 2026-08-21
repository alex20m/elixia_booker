// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AddClass from '@/app/AddClass';

/**
 * The class chooser, which is the only thing standing between a user and a
 * subscription for a class that does not exist.
 *
 * Everything it offers comes from /api/catalog — Elixia's real centres, and
 * the real weekly slots one of them publishes — so these tests drive it
 * through a stubbed catalogue and assert on what the form can produce, not on
 * how it is wired.
 */

const CENTERS = [
  { id: '740', name: 'Tapiola' },
  { id: '741', name: 'Sello' },
];

const TAPIOLA_CLASSES = [
  { className: 'Bodypump', weekday: 'monday', startTime: '09:00' },
  { className: 'Yoga', weekday: 'wednesday', startTime: '17:00' },
];

let container: HTMLDivElement;
let root: Root;
let posts: Array<{ url: string; body: unknown }>;
let classesByCenter: Record<string, typeof TAPIOLA_CLASSES>;
/** Centres whose timetable request hangs, so the loading state can be seen. */
let slowCenters: Set<string>;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (init?.method === 'POST') {
        posts.push({ url: target, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      const center = new URL(target, 'http://localhost').searchParams.get('center');
      if (center === null) return new Response(JSON.stringify({ centers: CENTERS }), { status: 200 });

      if (slowCenters.has(center)) return new Promise<Response>(() => {});

      const classes = classesByCenter[center];
      if (!classes) {
        return new Response(JSON.stringify({ error: `No Elixia centre named "${center}".` }), {
          status: 400,
        });
      }
      return new Response(JSON.stringify({ classes }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posts = [];
  // Keyed by club id, because that is what the chooser filters on — asking by
  // name would cost the server an extra ~1.5MB page fetch to resolve it.
  classesByCenter = { '740': TAPIOLA_CLASSES, '741': [] };
  slowCenters = new Set();
  stubFetch();
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
    root.render(<AddClass refresh={async () => {}} />);
  });
}

function select(id: string): HTMLSelectElement {
  const element = container.querySelector<HTMLSelectElement>(`#${id}`);
  if (!element) throw new Error(`no #${id} in the form`);
  return element;
}

function optionLabels(id: string): string[] {
  return [...select(id).options].map((o) => o.textContent ?? '');
}

async function choose(id: string, value: string): Promise<void> {
  await act(async () => {
    select(id).value = value;
    select(id).dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function clickAdd(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('#add-btn')!.click();
  });
}

describe('the class chooser', () => {
  it('offers Elixia\'s own centres rather than a box to type one into', async () => {
    await render();

    expect(container.querySelector('#s-center')?.tagName).toBe('SELECT');
    expect(optionLabels('s-center')).toContain('Tapiola');
    expect(optionLabels('s-center')).toContain('Sello');
  });

  it('offers only the classes the chosen centre publishes', async () => {
    await render();
    await choose('s-center', '740');

    expect(optionLabels('s-class').join('|')).toMatch(/Bodypump.*Monday.*09:00/);
    expect(optionLabels('s-class').join('|')).toMatch(/Yoga.*Wednesday.*17:00/);
    // One row per published slot, plus the "choose one" placeholder.
    expect(select('s-class').options).toHaveLength(TAPIOLA_CLASSES.length + 1);
  });

  it('submits the weekday and time of the class that was picked', async () => {
    // The point of the whole exercise: what is stored is a slot Elixia listed,
    // not a name, day and time assembled independently of each other.
    await render();
    await choose('s-center', '740');
    await choose('s-class', '1');
    await clickAdd();

    expect(posts).toEqual([
      {
        url: '/api/subscriptions',
        body: { className: 'Yoga', center: 'Tapiola', weekday: 'wednesday', startTime: '17:00' },
      },
    ]);
  });

  it('cannot add anything before a class is picked', async () => {
    await render();
    expect(container.querySelector<HTMLButtonElement>('#add-btn')!.disabled).toBe(true);

    await choose('s-center', '740');
    expect(container.querySelector<HTMLButtonElement>('#add-btn')!.disabled).toBe(true);

    await choose('s-class', '0');
    expect(container.querySelector<HTMLButtonElement>('#add-btn')!.disabled).toBe(false);
  });

  it('says a centre publishes nothing rather than showing an empty picker', async () => {
    await render();
    await choose('s-center', '741');

    // An empty dropdown that still opens reads as a page that failed to load.
    expect(select('s-class').disabled).toBe(true);
    expect(container.textContent).toMatch(/no classes/i);
    expect(posts).toEqual([]);
  });

  it('drops the old timetable the moment the centre changes, before the new one arrives', async () => {
    // The dangerous window is while the second centre's schedule is still in
    // flight: leaving the first centre's classes on screen lets someone pick a
    // Tapiola class with Sello selected, and the pair does not exist anywhere.
    classesByCenter['741'] = TAPIOLA_CLASSES;
    slowCenters = new Set(['741']);

    await render();
    await choose('s-center', '740');
    await choose('s-class', '0');
    await choose('s-center', '741');

    expect(optionLabels('s-class').join('|')).not.toMatch(/Bodypump/);
    expect(optionLabels('s-class').join('|')).toMatch(/Loading/);
    expect(container.querySelector<HTMLButtonElement>('#add-btn')!.disabled).toBe(true);
  });

  it('shows the server\'s reason when the catalogue cannot be read', async () => {
    classesByCenter = {};
    await render();
    await choose('s-center', '740');

    expect(container.textContent).toMatch(/No Elixia centre named "740"/);
  });
});
