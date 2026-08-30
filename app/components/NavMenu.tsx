'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseIcon, MenuIcon } from './icons';

export type NavSection<Id extends string = string> = {
  id: Id;
  label: string;
  icon: React.ReactNode;
};

/**
 * The app's whole navigation, in one component and one state.
 *
 * Two presentations of the same list, because the two widths want different
 * things. Wide enough and the sections sit in the bar itself, one click from
 * anywhere and always showing where you are. On a phone there is no room for
 * that beside the logo, so the same list moves behind a single button and
 * opens as a sheet under the bar — bigger targets than a bar of pills could
 * ever be, and no strip of chrome permanently eating the bottom of a screen
 * that is mostly list.
 *
 * Both copies are always in the document and CSS decides which one is on
 * screen; only one is ever in the accessibility tree, since the other is
 * `display: none`. Rendering them from one array is what keeps them honest —
 * the copy that is off-screen at the width you happen to be developing at is
 * exactly the one that rots when there are two hand-written lists.
 *
 * Sign out is not one of these sections and does not appear here at all: it
 * lives in Settings → Account, spelled out in full behind its own
 * confirmation, which is where a visitor goes looking for it rather than a
 * single tap away in a menu or the bar.
 */
export function NavMenu<Id extends string>({
  sections,
  current,
  onSelect,
}: {
  sections: NavSection<Id>[];
  current: Id;
  onSelect: (id: Id) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus goes back to the button the visitor pressed, not to the top of the
  // document — a keyboard user who opens and dismisses the menu should end up
  // exactly where they started.
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };

    document.addEventListener('keydown', onKeyDown);
    // Into the menu rather than leaving focus on the trigger, so Tab walks the
    // entries instead of the page behind them. Which entry that is depends on
    // the width: where the sections sit in the bar they are hidden here, and
    // the browser refuses focus to an element it is not rendering.
    //
    // Asking whether the focus took, rather than asking whether the element is
    // visible: a hidden ancestor does not change a child's own computed
    // `display`, so reading that would happily pick an entry that is not on
    // screen — and `offsetParent` and friends, which would see it, do not
    // exist under a DOM implementation with no layout.
    const items = panelRef.current?.querySelectorAll<HTMLElement>('.menu-item') ?? [];
    for (const item of Array.from(items)) {
      item.focus();
      if (document.activeElement === item) {
        // This focus() is us moving focus into the menu, not the visitor
        // tabbing to it — so it should not draw the focus ring that a real
        // keyboard visitor relies on. Whichever section happens to be first
        // (today, Classes) would otherwise show a stray ring every time the
        // menu opens, including on a touch tap. A genuine Tab back to this
        // item clears the class via blur, so the ring still appears then.
        item.classList.add('menu-item--opened-focus');
        item.addEventListener('blur', () => item.classList.remove('menu-item--opened-focus'), {
          once: true,
        });
        break;
      }
    }

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const pick = (id: Id) => {
    onSelect(id);
    // No focus restore: the visitor is looking at the section they just chose,
    // and throwing focus back to the menu button would announce the wrong thing.
    close(false);
  };

  return (
    <>
      {/* The wide-screen copy. Labelled the same as the one in the menu because
          only ever one of the two is rendered by the browser. */}
      <nav className="nav-inline" aria-label="Sections">
        {sections.map((section) => (
          <button
            key={section.id}
            id={`nav-${section.id}`}
            type="button"
            className="nav-link"
            aria-current={current === section.id ? 'page' : undefined}
            onClick={() => onSelect(section.id)}
          >
            {section.icon}
            <span>{section.label}</span>
          </button>
        ))}
      </nav>

      <button
        ref={triggerRef}
        id="menu-btn"
        type="button"
        className="btn-icon menu-trigger"
        aria-expanded={open}
        aria-controls="nav-menu"
        aria-label={open ? 'Close menu' : 'Menu'}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {open ? <CloseIcon /> : <MenuIcon />}
      </button>

      {open && (
        <>
          {/* A tap anywhere else is the commonest way out of a menu on a phone,
              and on a desktop it is how a dropdown is expected to behave. */}
          <div className="menu-backdrop" onClick={() => close(false)} />
          <div className="menu-panel" id="nav-menu" ref={panelRef}>
            <nav className="menu-nav" aria-label="Sections">
              {sections.map((section) => (
                <button
                  key={section.id}
                  id={`menu-${section.id}`}
                  type="button"
                  className="menu-item"
                  aria-current={current === section.id ? 'page' : undefined}
                  onClick={() => pick(section.id)}
                >
                  {section.icon}
                  <span>{section.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </>
      )}
    </>
  );
}
