// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AddClass from '@/app/AddClass';
import { titleCase } from '@/lib/dashboardState';

/**
 * The class chooser, which is the only thing standing between a user and a
 * subscription for a class that does not exist.
 *
 * Everything it offers comes from /api/catalog — Elixia's real centres, and
 * the real weekly slots one of them publishes — so these tests drive it
 * through a stubbed catalogue and assert on what the form can produce, not on
 * how it is wired.
 *
 * The choice is made in three steps — centre, then what to train, then when —
 * so the tests follow the same order, and pin the thing that makes a stepped
 * form dangerous: a leftover selection from the previous step, which is how a
 * pair that exists nowhere on the timetable gets submitted.
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

// Two classes, each running twice a week, and one time they share: enough for
// "which class" and "which slot" to be genuinely separate questions, and for a
// slot index carried across a class change to land on the wrong row.
const TAPIOLA_CLASSES = [
  { className: 'Bodypump', weekday: 'monday', startTime: '09:00' },
  { className: 'Yoga', weekday: 'monday', startTime: '18:00' },
  { className: 'Bodypump', weekday: 'wednesday', startTime: '17:00' },
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

/**
 * The class and day/time pickers, which are drawn the same way as the centre:
 * a button showing the chosen row (or its placeholder) and a listbox the form
 * opens itself, rather than a native `<select>`.
 */
function listboxButton(id: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`#${id}`);
  if (!element) throw new Error(`no #${id} in the form`);
  return element;
}

/** What the button shows: the chosen row's label, or its placeholder. */
function listboxText(id: string): string {
  return listboxButton(id).textContent ?? '';
}

const listboxDisabled = (id: string): boolean => listboxButton(id).disabled;

const listboxOpen = (id: string): boolean => container.querySelector(`#${id}-list`) !== null;

/** Whether a row is chosen, as opposed to the button showing its placeholder. */
const listboxHasSelection = (id: string): boolean =>
  listboxButton(id).querySelector('.combo-placeholder') === null;

/** The rows the listbox is currently showing, which the form draws itself. */
function listboxOptions(id: string): string[] {
  return [...container.querySelectorAll<HTMLElement>(`#${id}-list [role="option"]`)].map(
    (option) => option.textContent ?? '',
  );
}

async function openListbox(id: string): Promise<void> {
  await act(async () => {
    listboxButton(id).click();
  });
}

/** Opens the list only if it is not already open — opening twice would close it. */
async function ensureListboxOpen(id: string): Promise<void> {
  if (!listboxOpen(id)) await openListbox(id);
}

async function pressListbox(id: string, key: string): Promise<void> {
  await act(async () => {
    listboxButton(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** The row the keyboard would commit, which is what the button points at. */
function activeListboxOption(id: string): string | null {
  const activeId = listboxButton(id).getAttribute('aria-activedescendant');
  return activeId ? (container.querySelector(`#${activeId}`)?.textContent ?? null) : null;
}

async function clickListboxOption(id: string, label: string): Promise<void> {
  await openListbox(id);
  const option = [...container.querySelectorAll<HTMLElement>(`#${id}-list [role="option"]`)].find(
    (row) => row.textContent === label,
  );
  if (!option) throw new Error(`no "${label}" on the #${id} list`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

const chooseClass = (className: string): Promise<void> => clickListboxOption('s-class', className);

/** The label a slot's `weekday|HH:MM` key renders as. */
const slotLabel = (key: string): string => {
  const [weekday = '', time = ''] = key.split('|');
  return `${titleCase(weekday)} ${time}`;
};

const chooseSlot = (slot: string): Promise<void> => clickListboxOption('s-slot', slotLabel(slot));

// A plain `input.value = text` goes through React's own tracked setter, which
// updates its recorded value at the same time — so the dispatched event sees
// no difference and onChange never fires. Setting through the native
// descriptor bypasses that tracker, the same way user typing would.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

function centerBox(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>('#s-center');
  if (!element) throw new Error('no #s-center in the form');
  return element;
}

/** The rows the listbox is currently showing, which the form draws itself. */
function centerList(): string[] {
  return [...container.querySelectorAll<HTMLElement>('#s-center-list [role="option"]')].map(
    (option) => option.textContent ?? '',
  );
}

const centerListOpen = (): boolean => container.querySelector('#s-center-list') !== null;

/** Focusing the box is what opens it, the way a dropdown opens when clicked. */
async function openCenter(): Promise<void> {
  await act(async () => {
    centerBox().dispatchEvent(new Event('focusin', { bubbles: true }));
  });
}

async function typeCenter(text: string): Promise<void> {
  await act(async () => {
    const box = centerBox();
    nativeInputValueSetter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Picking with the pointer, which must beat the blur that would revert it. */
async function clickCenterOption(name: string): Promise<void> {
  const option = [...container.querySelectorAll<HTMLElement>('#s-center-list [role="option"]')].find(
    (row) => row.textContent === name,
  );
  if (!option) throw new Error(`no "${name}" on the centre list`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

async function pressCenter(key: string): Promise<void> {
  await act(async () => {
    centerBox().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** React listens for focusout, not the blur that does not bubble. */
async function leaveCenter(): Promise<void> {
  await act(async () => {
    centerBox().dispatchEvent(new Event('focusout', { bubbles: true }));
  });
}

/** The row the keyboard would commit, which is what the box points at. */
function activeCenterOption(): string | null {
  const id = centerBox().getAttribute('aria-activedescendant');
  return id ? (container.querySelector(`#${id}`)?.textContent ?? null) : null;
}

// Named by id because that is what the form works in, chosen off the list
// because that is what a person actually does with a dropdown.
const chooseCenter = async (id: string): Promise<void> => {
  const name = CENTERS.find((option) => option.id === id)?.name ?? id;
  await openCenter();
  await clickCenterOption(name);
};

async function clickAdd(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('#add-btn')!.click();
  });
}

const addDisabled = (): boolean =>
  container.querySelector<HTMLButtonElement>('#add-btn')!.disabled;

describe('finding a centre', () => {
  it('asks for the centre in one box, not a search field and a dropdown', async () => {
    // Two controls for one answer is two things to understand before the
    // first question is even answered.
    await render();

    expect(centerBox().tagName).toBe('INPUT');
    expect(container.querySelector('#s-center-search')).toBeNull();
    expect(container.querySelectorAll('#s-center, select[id^="s-center"]')).toHaveLength(1);
  });

  it('draws its own list instead of handing the catalogue to a native datalist', async () => {
    // A datalist cannot be styled, so it renders as a raw browser popup beside
    // two styled selects; browsers disagree on when it opens at all, and iOS
    // Safari barely shows one. The list has to be ours to be usable.
    await render();
    await openCenter();

    expect(container.querySelector('datalist')).toBeNull();
    expect(centerBox().getAttribute('list')).toBeNull();
    expect(container.querySelector('#s-center-list')?.getAttribute('role')).toBe('listbox');
  });

  it('keeps the chevron transparent rather than letting the base button style fill it', () => {
    // No rendering test can see this: jsdom applies no stylesheet, so the
    // chevron passes every assertion here while painting as a solid navy block
    // with an invisible icon on it in a real browser.
    //
    // This used to assert source order too. The base rule was
    // `button:not([data-slot])`, whose :not() carried a class's worth of
    // specificity, so a lone `.combo-toggle` lost to it and the chevron had to
    // be written `button.combo-toggle` *and* placed after it to win. That
    // guard is `:where()`-wrapped now and costs nothing, so one class is
    // enough and the ordering trick is gone — the property that replaced it is
    // asserted in tests/signedOut.test.tsx. What is left here is the chevron's
    // own half of the bargain: it has to declare the transparent background it
    // relies on.
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    const toggle = css.indexOf('.combo-toggle {');

    expect(toggle).toBeGreaterThan(-1);
    expect(css.slice(toggle, css.indexOf('}', toggle))).toMatch(/background:\s*transparent/);
  });

  it('shows every centre the moment the box is opened, before anything is typed', async () => {
    // The whole point of keeping a dropdown: someone who cannot spell their
    // club still has to be able to find it by looking. A picker that stays
    // empty until it is typed into has no list at all.
    await render();
    expect(centerListOpen()).toBe(false);

    await openCenter();

    expect(centerList()).toEqual(['Tapiola', 'Sello', 'Kamppi']);
  });

  it('keeps the whole list open when the box already holds the chosen centre', async () => {
    // Reopening on a chosen centre must not filter down to that one centre —
    // that is a dropdown that only ever offers what is already picked, and
    // switching gyms becomes impossible without clearing the box first.
    defaults = { center: '740' };
    await render();
    await openCenter();

    expect(centerBox().value).toBe('Tapiola');
    expect(centerList()).toEqual(['Tapiola', 'Sello', 'Kamppi']);
  });

  it('matches text anywhere in the name, not only at the start', async () => {
    // "ell" is in the middle of Sello. Prefix-only matching is what the
    // browser's own datalist did, and it hides the club unless the first
    // letters are already right — which is the case someone searches in.
    await render();
    await openCenter();
    await typeCenter('ell');

    expect(centerList()).toEqual(['Sello']);
  });

  it('picks the centre from a single click on the list', async () => {
    // Typing the club's full name to select it is not a dropdown.
    await render();
    await openCenter();
    await clickCenterOption('Sello');

    expect(centerBox().value).toBe('Sello');
    expect(centerListOpen()).toBe(false);
    expect(saved).toEqual([{ center: '741' }]);
  });

  it('picks the centre with the keyboard alone', async () => {
    await render();
    await openCenter();
    await pressCenter('ArrowDown');
    await pressCenter('ArrowDown');

    expect(activeCenterOption()).toBe('Sello');

    await pressCenter('Enter');

    expect(centerBox().value).toBe('Sello');
    expect(centerListOpen()).toBe(false);
    expect(saved).toEqual([{ center: '741' }]);
  });

  it('closes on Escape without changing the centre', async () => {
    await render();
    await chooseCenter('740');
    await openCenter();
    await typeCenter('Sel');
    await pressCenter('Escape');

    expect(centerListOpen()).toBe(false);
    // Escape abandons the search, so the box has to go back to saying what the
    // form is still acting on rather than leaving "Sel" over Tapiola's classes.
    expect(centerBox().value).toBe('Tapiola');
    expect(saved).toEqual([{ center: '740' }]);
  });

  it('picks the centre whose name is typed in full', async () => {
    await render();
    await openCenter();
    await typeCenter('Tapiola');
    await ensureListboxOpen('s-class');

    expect(listboxOptions('s-class').join('|')).toMatch(/Bodypump/);
    expect(saved).toEqual([{ center: '740' }]);
  });

  it('picks it regardless of case and stray spacing', async () => {
    // Names come back from the box the way a person types them, and "sello"
    // typed at speed is the same club as the "Sello" on the list.
    await render();
    await typeCenter('  kAMPPI ');
    await ensureListboxOpen('s-class');

    expect(listboxOptions('s-class').join('|')).toMatch(/Bodypump/);
    expect(saved).toEqual([{ center: '742' }]);
  });

  it('picks nothing from a name that is still half typed', async () => {
    // "Tap" matches Tapiola and nothing else, but a prefix is not a choice:
    // acting on it would pick a club out from under someone mid-word.
    await render();
    await typeCenter('Tap');

    expect(listboxText('s-class')).toBe('Choose a centre first');
    expect(saved).toEqual([]);
    expect(addDisabled()).toBe(true);
  });

  it('says so when nothing on the list matches what was typed', async () => {
    await render();
    await typeCenter('nowhere');

    expect(container.textContent).toMatch(/no centres match/i);
  });

  it('stays quiet while a half-typed name still matches something', async () => {
    // The warning has to mean "there is nothing here", not "you have not
    // finished typing" — otherwise it is on screen for most of every search.
    await render();
    await typeCenter('sel');

    expect(container.textContent).not.toMatch(/no centres match/i);
  });

  it('restores the chosen centre when the box is left holding something else', async () => {
    // A box reading "nonsense" over a form that is still acting on Tapiola is
    // the one lie a single control can tell that two could not.
    await render();
    await chooseCenter('740');
    await chooseClass('Bodypump');
    await typeCenter('nonsense');

    // Still Tapiola's form while the search is under way: every search for a
    // second gym passes through text that matches nothing, and emptying the
    // class list there throws away a choice already made for a search that may
    // end in giving up.
    await ensureListboxOpen('s-class');
    expect(listboxOptions('s-class').join('|')).toMatch(/Bodypump/);
    expect(listboxText('s-class')).toBe('Bodypump');

    await leaveCenter();

    expect(centerBox().value).toBe('Tapiola');
    await ensureListboxOpen('s-class');
    expect(listboxOptions('s-class').join('|')).toMatch(/Bodypump/);
  });

  it('empties the box when it is left holding a centre that was never chosen', async () => {
    await render();
    await typeCenter('nonsense');
    await leaveCenter();

    expect(centerBox().value).toBe('');
    expect(listboxText('s-class')).toBe('Choose a centre first');
  });

  it('clearing the box unpicks the centre and the classes with it', async () => {
    await render();
    await chooseCenter('740');
    await chooseClass('Bodypump');
    await typeCenter('');

    expect(listboxText('s-class')).toBe('Choose a centre first');
    expect(listboxDisabled('s-class')).toBe(true);
    expect(addDisabled()).toBe(true);
  });

  it('clearing the box does not forget where you train', async () => {
    // Editing the text is how every search starts. Writing an empty centre
    // away mid-keystroke would spend the memory of a real choice on a
    // half-typed one.
    await render();
    await chooseCenter('740');
    await typeCenter('');

    expect(saved).toEqual([{ center: '740' }]);
  });
});

describe('choosing what to train', () => {
  it('offers each class the centre publishes once, however often it runs', async () => {
    // The first question is *what*, so a class that runs twice a week is one
    // choice here — repeating it per slot is the flat list this step exists to
    // break up.
    await render();
    await chooseCenter('740');
    await ensureListboxOpen('s-class');

    expect(listboxOptions('s-class').filter((label) => label === 'Bodypump')).toHaveLength(1);
    expect(listboxOptions('s-class').filter((label) => label === 'Yoga')).toHaveLength(1);
    // One row per distinct class — there is no placeholder row any more, since
    // the placeholder lives on the closed button instead.
    expect(listboxOptions('s-class')).toHaveLength(2);
  });

  it('keeps days and times out of the class step', async () => {
    await render();
    await chooseCenter('740');
    await ensureListboxOpen('s-class');

    expect(listboxOptions('s-class').join('|')).not.toMatch(/\d\d:\d\d/);
    expect(listboxOptions('s-class').join('|')).not.toMatch(/monday/i);
  });

  it('says a centre publishes nothing rather than showing an empty picker', async () => {
    await render();
    await chooseCenter('741');

    // An empty dropdown that still opens reads as a page that failed to load.
    expect(listboxDisabled('s-class')).toBe(true);
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
    await chooseClass('Bodypump');
    await chooseCenter('741');

    expect(listboxText('s-class')).not.toMatch(/Bodypump/);
    expect(listboxText('s-class')).toMatch(/Loading/);
    expect(listboxDisabled('s-slot')).toBe(true);
    expect(addDisabled()).toBe(true);
  });
});

describe('the class and slot pickers draw their own list, like the centre', () => {
  it('shows every class the moment the box is opened', async () => {
    await render();
    await chooseCenter('740');
    await openListbox('s-class');

    expect(listboxOptions('s-class')).toEqual(['Bodypump', 'Yoga']);
  });

  it('picks a class with the keyboard alone', async () => {
    await render();
    await chooseCenter('740');
    await openListbox('s-class');
    await pressListbox('s-class', 'ArrowDown');
    await pressListbox('s-class', 'ArrowDown');

    expect(activeListboxOption('s-class')).toBe('Yoga');

    await pressListbox('s-class', 'Enter');

    expect(listboxOpen('s-class')).toBe(false);
    expect(listboxText('s-class')).toBe('Yoga');
  });

  it('leaves the picked slot alone when its list is closed with Escape', async () => {
    await render();
    await chooseCenter('740');
    await chooseClass('Yoga');
    await chooseSlot('monday|18:00');
    await openListbox('s-slot');
    await pressListbox('s-slot', 'Escape');

    expect(listboxOpen('s-slot')).toBe(false);
    expect(listboxText('s-slot')).toBe('Monday 18:00');
  });

  it('closes without picking anything when focus leaves the button', async () => {
    await render();
    await chooseCenter('740');
    await openListbox('s-class');

    // React listens for focusout, not the blur that does not bubble.
    await act(async () => {
      listboxButton('s-class').dispatchEvent(new Event('focusout', { bubbles: true }));
    });

    expect(listboxOpen('s-class')).toBe(false);
    expect(listboxHasSelection('s-class')).toBe(false);
  });
});

describe('choosing when', () => {
  it('waits for a class before offering any times', async () => {
    await render();
    await chooseCenter('740');

    expect(listboxDisabled('s-slot')).toBe(true);
    expect(listboxText('s-slot')).toMatch(/class/i);
  });

  it('offers only the days and times the chosen class actually runs', async () => {
    await render();
    await chooseCenter('740');
    await chooseClass('Yoga');
    await ensureListboxOpen('s-slot');

    expect(listboxOptions('s-slot')).toEqual(['Monday 18:00', 'Wednesday 17:00']);
  });

  it('submits the weekday and time of the slot that was picked', async () => {
    // The point of the whole exercise: what is stored is a slot Elixia listed,
    // not a name, day and time assembled independently of each other.
    await render();
    await chooseCenter('740');
    await chooseClass('Yoga');
    await chooseSlot('wednesday|17:00');
    await clickAdd();

    expect(posts).toEqual([
      {
        url: '/api/subscriptions',
        body: { className: 'Yoga', center: 'Tapiola', weekday: 'wednesday', startTime: '17:00' },
      },
    ]);
  });

  it('cannot add anything before a slot is picked', async () => {
    await render();
    expect(addDisabled()).toBe(true);

    await chooseCenter('740');
    expect(addDisabled()).toBe(true);

    await chooseClass('Bodypump');
    expect(addDisabled()).toBe(true);

    await chooseSlot('monday|09:00');
    expect(addDisabled()).toBe(false);
  });

  it('forgets the chosen time when the class changes under it', async () => {
    // Both classes run on Wednesday at 17:00, so a slot kept across the change
    // stays selectable and submits happily — as the other class, which is not
    // what anyone picked.
    await render();
    await chooseCenter('740');
    await chooseClass('Yoga');
    await chooseSlot('wednesday|17:00');
    await chooseClass('Bodypump');

    expect(listboxHasSelection('s-slot')).toBe(false);
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

    expect(centerBox().value).toBe('Tapiola');
    // The saved centre is only worth anything if it saves the fetch too.
    await ensureListboxOpen('s-class');
    expect(listboxOptions('s-class').join('|')).toMatch(/Bodypump/);
  });

  it('never remembers the class, which is the one thing being decided', async () => {
    defaults = { center: '740' };
    await render();
    await chooseClass('Bodypump');
    await chooseSlot('monday|09:00');
    await clickAdd();

    // Nothing about the class is saved, and both pickers are empty again for
    // the next one — a prefilled class is a subscription nobody meant to
    // create.
    expect(saved.every((entry) => !JSON.stringify(entry).includes('Bodypump'))).toBe(true);
    expect(listboxHasSelection('s-class')).toBe(false);
    expect(listboxHasSelection('s-slot')).toBe(false);
  });

  it('opens on an empty form when the remembered centre has since closed', async () => {
    // Clubs come and go, and a remembered id that is no longer offered is not
    // a centre the form may act on: selecting it anyway leaves the dropdown
    // rendering blank — no option carries that value — while the form fetches
    // its timetable and greets the visitor with an error about a centre they
    // never chose.
    defaults = { center: '999' };
    await render();

    expect(centerBox().value).toBe('');
    expect(container.textContent).not.toMatch(/999/);
    expect(listboxText('s-class')).toBe('Choose a centre first');
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
    await openCenter();
    expect(centerList()).toContain('Tapiola');
  });
});
