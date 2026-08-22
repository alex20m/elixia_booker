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
 *
 * The centre is remembered between visits — the same gym every week, out of
 * 226 — so these tests pin both halves of that: what is saved as it is
 * chosen, and what is offered back on the next visit. The class is never
 * among it.
 */

const CENTERS = [
  { id: '740', name: 'Tapiola' },
  { id: '741', name: 'Sello' },
  { id: '742', name: 'Kamppi' },
];

const TAPIOLA_CLASSES = [
  { className: 'Bodypump', weekday: 'monday', startTime: '09:00' },
  { className: 'Yoga', weekday: 'wednesday', startTime: '17:00' },
];

interface Defaults {
  center: string;
}

let container: HTMLDivElement;
let root: Root;
let posts: Array<{ url: string; body: unknown }>;
let saved: Defaults[];
/** What the server says this user chose last time. */
let defaults: Defaults;
let classesByCenter: Record<string, typeof TAPIOLA_CLASSES>;
/** Centres whose timetable request hangs, so the loading state can be seen. */
let slowCenters: Set<string>;

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);

      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Defaults;
        saved.push(body);
        defaults = body;
        return new Response(JSON.stringify({ defaults: body }), { status: 200 });
      }

      if (init?.method === 'POST') {
        posts.push({ url: target, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (target.startsWith('/api/preferences')) {
        return new Response(JSON.stringify({ defaults }), { status: 200 });
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
  saved = [];
  defaults = { center: '' };
  // Keyed by club id, because that is what the chooser filters on — asking by
  // name would cost the server an extra ~1.5MB page fetch to resolve it.
  classesByCenter = { '740': TAPIOLA_CLASSES, '741': [], '742': TAPIOLA_CLASSES };
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

const chooseCenter = (center: string): Promise<void> => choose('s-center', center);

async function clickAdd(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('#add-btn')!.click();
  });
}

const addDisabled = (): boolean =>
  container.querySelector<HTMLButtonElement>('#add-btn')!.disabled;

describe('finding a centre', () => {
  it("offers Elixia's own centres rather than a box to type one into", async () => {
    await render();

    expect(select('s-center').tagName).toBe('SELECT');
    expect(optionLabels('s-center')).toContain('Tapiola');
    expect(optionLabels('s-center')).toContain('Sello');
    expect(optionLabels('s-center')).toContain('Kamppi');
  });
});

describe('the class chooser', () => {
  it('offers only the classes the chosen centre publishes', async () => {
    await render();
    await chooseCenter('740');

    expect(optionLabels('s-class').join('|')).toMatch(/Bodypump.*Monday.*09:00/);
    expect(optionLabels('s-class').join('|')).toMatch(/Yoga.*Wednesday.*17:00/);
    // One row per published slot, plus the "choose one" placeholder.
    expect(select('s-class').options).toHaveLength(TAPIOLA_CLASSES.length + 1);
  });

  it('submits the weekday and time of the class that was picked', async () => {
    // The point of the whole exercise: what is stored is a slot Elixia listed,
    // not a name, day and time assembled independently of each other.
    await render();
    await chooseCenter('740');
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
    expect(addDisabled()).toBe(true);

    await chooseCenter('740');
    expect(addDisabled()).toBe(true);

    await choose('s-class', '0');
    expect(addDisabled()).toBe(false);
  });

  it('says a centre publishes nothing rather than showing an empty picker', async () => {
    await render();
    await chooseCenter('741');

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
    await chooseCenter('740');
    await choose('s-class', '0');
    await choose('s-center', '741');

    expect(optionLabels('s-class').join('|')).not.toMatch(/Bodypump/);
    expect(optionLabels('s-class').join('|')).toMatch(/Loading/);
    expect(addDisabled()).toBe(true);
  });

  it('shows the server\'s reason when the catalogue cannot be read', async () => {
    classesByCenter = {};
    await render();
    await chooseCenter('740');

    expect(container.textContent).toMatch(/No Elixia centre named "740"/);
  });
});

describe('remembering where you train', () => {
  it('saves the centre as soon as it is chosen, not only once a class is added', async () => {
    // Choosing a gym and then thinking better of the class is still the same
    // gym next week, and nothing was added for a save-on-add to hang off.
    await render();
    await chooseCenter('740');

    expect(saved).toEqual([{ center: '740' }]);
    expect(posts).toEqual([]);
  });

  it('starts at the remembered centre, with its classes already offered', async () => {
    defaults = { center: '740' };
    await render();

    expect(select('s-center').value).toBe('740');
    // The saved centre is only worth anything if it saves the fetch too.
    expect(optionLabels('s-class').join('|')).toMatch(/Bodypump/);
  });

  it('never remembers the class, which is the one thing being decided', async () => {
    defaults = { center: '740' };
    await render();
    await choose('s-class', '0');
    await clickAdd();

    // Nothing about the class is saved, and the picker is empty again for the
    // next one — a prefilled class is a subscription nobody meant to create.
    expect(saved.every((entry) => !JSON.stringify(entry).includes('Bodypump'))).toBe(true);
    expect(select('s-class').value).toBe('');
  });

  it('opens on an empty form when the remembered centre has since closed', async () => {
    // Clubs come and go, and a remembered id that is no longer offered is not
    // a centre the form may act on: selecting it anyway leaves the dropdown
    // rendering blank — no option carries that value — while the form fetches
    // its timetable and greets the visitor with an error about a centre they
    // never chose.
    defaults = { center: '999' };
    await render();

    expect(select('s-center').value).toBe('');
    expect(container.textContent).not.toMatch(/999/);
    expect(select('s-class').options[0]?.textContent).toBe('Choose a centre first');
    expect(addDisabled()).toBe(true);
  });

  it('still offers the form when the remembered centre cannot be read', async () => {
    // A failed preferences read is a lost convenience, not a broken chooser.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/preferences')
          ? new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
          : new Response(JSON.stringify({ centers: CENTERS }), { status: 200 }),
      ),
    );

    await render();
    expect(optionLabels('s-center')).toContain('Tapiola');
  });
});
