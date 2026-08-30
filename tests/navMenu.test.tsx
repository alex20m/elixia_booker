// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { NavMenu } = await import('@/app/components/NavMenu');

/**
 * The single navigation control: a row of links in the bar where there is room
 * for one, and a menu behind one button where there is not.
 *
 * The rules worth pinning are the ones a redesign quietly breaks — that both
 * copies drive the same callback, and that the menu can be closed by every
 * route a visitor tries (Escape, the backdrop, picking something). CSS
 * decides which copy is on screen at a given width; both are in the document
 * at every width, so this file asserts on behaviour rather than on which one
 * is visible.
 *
 * Sign out is deliberately not covered here — it does not appear in this
 * component at all any more; see tests/signOutButton.test.tsx.
 */

const SECTIONS = [
  { id: 'classes', label: 'Classes', icon: <i /> },
  { id: 'activity', label: 'Activity', icon: <i /> },
  { id: 'settings', label: 'Settings', icon: <i /> },
] as const;

let container: HTMLDivElement;
let root: Root;
type SectionId = (typeof SECTIONS)[number]['id'];

let onSelect: ReturnType<typeof vi.fn<(id: SectionId) => void>>;

const render = (current: SectionId = 'classes'): void => {
  act(() => {
    root.render(<NavMenu sections={[...SECTIONS]} current={current} onSelect={onSelect} />);
  });
};

const byId = <T extends HTMLElement>(id: string): T | null => container.querySelector<T>(`#${id}`);

const click = async (el: Element | null): Promise<void> => {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const press = async (key: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

const open = async (): Promise<void> => click(byId('menu-btn'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSelect = vi.fn<(id: SectionId) => void>();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('NavMenu', () => {
  it('keeps the menu shut until the button is pressed', () => {
    render();

    expect(byId('nav-menu')).toBeNull();
    expect(byId('menu-btn')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a menu listing every section', async () => {
    render();
    await open();

    expect(byId('menu-btn')!.getAttribute('aria-expanded')).toBe('true');
    const labels = [...container.querySelectorAll('#nav-menu .menu-item')].map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(['Classes', 'Activity', 'Settings']);
  });

  it('switches section and closes when a menu entry is picked', async () => {
    render();
    await open();
    await click(byId('menu-activity'));

    expect(onSelect).toHaveBeenCalledWith('activity');
    expect(byId('nav-menu')).toBeNull();
  });

  it('switches section from the bar links, which need no menu at all', async () => {
    render();
    await click(byId('nav-settings'));

    expect(onSelect).toHaveBeenCalledWith('settings');
  });

  it('marks the current section in both the bar and the menu', async () => {
    render('activity');
    await open();

    expect(byId('nav-activity')!.getAttribute('aria-current')).toBe('page');
    expect(byId('nav-classes')!.getAttribute('aria-current')).toBeNull();
    expect(byId('menu-activity')!.getAttribute('aria-current')).toBe('page');
    expect(byId('menu-settings')!.getAttribute('aria-current')).toBeNull();
  });

  it('closes on Escape and hands focus back to the button that opened it', async () => {
    render();
    await open();
    await press('Escape');

    expect(byId('nav-menu')).toBeNull();
    expect(document.activeElement).toBe(byId('menu-btn'));
  });

  it('closes when the backdrop behind it is tapped', async () => {
    render();
    await open();
    await click(container.querySelector('.menu-backdrop'));

    expect(byId('nav-menu')).toBeNull();
  });

  it('moves focus into the menu so it can be driven from the keyboard', async () => {
    render();
    await open();

    expect(document.activeElement).toBe(byId('menu-classes'));
  });

  it('does not mark the item it auto-focused on open for a visible focus ring', async () => {
    render();
    await open();

    expect(byId('menu-classes')!.classList.contains('menu-item--opened-focus')).toBe(true);
  });

  it('lets a real Tab back to the auto-focused item show its focus ring again', async () => {
    render();
    await open();
    const classesItem = byId('menu-classes')!;
    expect(classesItem.classList.contains('menu-item--opened-focus')).toBe(true);

    await act(async () => {
      classesItem.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });

    expect(classesItem.classList.contains('menu-item--opened-focus')).toBe(false);
  });
});
