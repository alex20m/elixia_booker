'use client';

import { useEffect, useRef, useState } from 'react';
import { apiRequest as api, titleCase } from '@/lib/dashboardState';
import type { CenterDefaults } from '@/lib/service';
import type { CenterOption, ClassOption } from '@/lib/types';
import { ActionButton } from './components/ActionButton';
import { Spinner } from './components/Loading';
import { ChevronIcon, PlusIcon } from './components/icons';

/**
 * Picking a class, from the classes that exist.
 *
 * This used to be four free-text fields, and every one of them could be wrong
 * in a way nothing noticed: a misremembered class name, a centre spelled the
 * way people say it rather than the way Elixia lists it, a time that is close
 * to a real one. The subscription looked fine in the list, and then failed to
 * resolve at T-0 every single week — the app's quietest possible failure,
 * since "not listed yet" is also what a class looks like before its window
 * opens.
 *
 * So the form is now built from the live schedule: centres come from Elixia's
 * own filter, classes from the timetable that centre publishes, and the
 * weekday and start time are properties of the slot that was picked rather
 * than three fields a user has to keep consistent with each other. The server
 * checks the same thing again — this is a chooser, not the guard.
 *
 * The choice is made in the order a person actually makes it: where, then
 * what, then when. A single list of every published slot put those last two
 * questions in one row, so a centre running twenty classes across the week
 * offered a hundred lines to scroll, with each class scattered through them —
 * finding "the Wednesday Bodypump" meant reading past every other class to
 * find out which days Bodypump even runs. Splitting it means the class list is
 * as long as the centre has classes, and the times are only the times that one
 * class runs.
 *
 * The centre is asked for in one box rather than a search field feeding a
 * dropdown. Two controls for one answer is two things to work out before the
 * first question is even answered, and the pair could disagree — text reading
 * one club over a form acting on another. So the box is the picker: a centre
 * counts as chosen only once what is in the box is a club Elixia lists, and
 * anything else left in it is put back to the chosen centre when the box is
 * left, so it never shows a club the form is not actually using.
 *
 * The list under it is drawn here rather than handed to a native `<datalist>`,
 * which is what this started as and could not stay. A datalist takes no styling
 * at all, so it renders as a raw browser popup next to two styled selects;
 * browsers disagree on whether it opens before anything is typed, which turns
 * "pick your gym from the list" into "already know how it is spelled"; several
 * match only the *start* of a name, hiding Sello from "ell"; and on iOS Safari
 * it barely appears. Owning the list costs the keyboard and ARIA wiring below
 * and buys a control that behaves the same everywhere: it opens on focus
 * showing every club, matches anywhere in the name, and is picked with one tap.
 *
 * The centre is remembered between visits, because it does not change:
 * someone books at their own gym week after week, and picking it out of 226
 * clubs is a chore in front of the choice that actually matters. It was worth
 * more than that — country → city → club is how a list this long ought to be
 * navigated — but the schedule page carries no club locations to build that
 * from, so the list stays flat and the memory does the work instead.
 *
 * The class is deliberately not remembered. It is the one thing being decided
 * here, and a prefilled one is a subscription nobody meant to create.
 */

/**
 * A list fetched from the server.
 *
 * Modelled as one value with a state, rather than a list plus flags, because
 * "empty" and "not loaded yet" and "failed" all render as *nothing* if they
 * are allowed to collapse into each other — and an empty picker with no
 * explanation is the failure that looks like a broken page.
 */
type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

async function fetchRemote<T>(load: () => Promise<T>): Promise<Remote<T>> {
  try {
    return { status: 'ready', value: await load() };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}

/**
 * How two spellings of the same class are recognised as one.
 *
 * The timetable is free text filed by whoever set the class up, so the same
 * class can arrive as "Bodypump" one day and "BODYPUMP  60" — well, "Bodypump"
 * with a stray double space — the next. Grouping on the raw string would list
 * it twice, which is exactly the duplication this step exists to remove. Same
 * normalisation the schedule parser dedupes slots with.
 */
const sameClass = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How a typed centre matches the one on the list.
 *
 * Same folding as class names, for the same reason and one more: what arrives
 * here was typed rather than clicked, so "sello" at speed and a trailing space
 * from a paste both have to land on the club the catalogue calls "Sello".
 */
const sameName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Identifies a slot within one class, and survives the list being refetched. */
const slotKey = (option: ClassOption): string => `${option.weekday}|${option.startTime}`;

/**
 * Keep the arrowed-to row on screen.
 *
 * The list scrolls at around eight rows and the catalogue runs to 226, so
 * without this the highlight walks off the bottom on the ninth press and the
 * keyboard stops being a way to reach anything. Optional-called because jsdom
 * has no layout and so does not implement it.
 */
const scrollActiveIntoView = (row: HTMLLIElement | null): void =>
  row?.scrollIntoView?.({ block: 'nearest' });

export default function AddClass({ refresh }: { refresh: () => Promise<void> }) {
  const [centers, setCenters] = useState<Remote<CenterOption[]>>({ status: 'loading' });
  /** Elixia's numeric club id: filtering by it skips a whole page fetch. */
  const [center, setCenter] = useState('');
  /**
   * What is in the centre box, which is not the same as the centre chosen: it
   * is free text until it spells one of Elixia's clubs exactly.
   */
  const [centerText, setCenterText] = useState('');
  /** Whether the list is showing. Opening it is how the catalogue is browsed. */
  const [centerOpen, setCenterOpen] = useState(false);
  /**
   * Whether what is in the box should narrow the list.
   *
   * Not the same as "the box has text in it": a chosen centre fills the box
   * with its own name, and filtering on that would reopen the list showing
   * only the club already picked — a dropdown that offers nothing but the
   * current answer, so switching gyms would mean clearing the box first.
   * Typing turns it on; choosing and reopening turn it back off.
   */
  const [centerFiltering, setCenterFiltering] = useState(false);
  /** Row the keyboard would commit; -1 until an arrow key picks one out. */
  const [centerActive, setCenterActive] = useState(-1);
  const centerInput = useRef<HTMLInputElement>(null);
  // Tagged with the centre it describes, so a timetable is never read as
  // belonging to a centre it was not fetched for — the same trick the
  // dashboard plays with the signed-in user, and for the same reason: without
  // it, the previous centre's classes stay pickable until the next response
  // lands.
  const [loaded, setLoaded] = useState<{ center: string; remote: Remote<ClassOption[]> } | null>(
    null,
  );
  /** The class being booked, as it is spelled on the timetable. */
  const [className, setClassName] = useState('');
  /** Which of that class's weekly slots, as `weekday|HH:MM`. */
  const [slot, setSlot] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    // Asked for together: the remembered place is only useful alongside the
    // list it has to be matched against, and serialising them would leave the
    // form visibly re-filling itself after it had already been drawn.
    void (async () => {
      const [remote, saved] = await Promise.all([
        fetchRemote(async () => (await api<{ centers: CenterOption[] }>('/api/catalog')).centers),
        // A centre that cannot be read is a lost convenience, not a broken
        // chooser: everything still works, it just starts empty.
        api<{ defaults: CenterDefaults }>('/api/preferences')
          .then((body) => body.defaults)
          .catch(() => null),
      ]);
      if (!active) return;

      setCenters(remote);
      if (saved) applySaved(remote.status === 'ready' ? remote.value : [], saved);
    })();

    /**
     * Select the remembered centre, but only if Elixia still offers it.
     *
     * Checked against today's list rather than trusted: clubs come and go,
     * and a select whose value no option carries renders blank while the form
     * believes a centre is chosen — so it would fetch a dead club's timetable
     * and open on an error about a centre the visitor never picked.
     */
    function applySaved(options: CenterOption[], saved: CenterDefaults): void {
      const option = options.find((entry) => entry.id === saved.center);
      if (!option) return;
      setCenter(option.id);
      // The box has to say so as well: a chosen centre it does not name is the
      // same silence as no centre at all.
      setCenterText(option.name);
    }

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!center) return;

    // `active` matters here beyond tidiness: changing centre twice quickly
    // could otherwise land the first centre's timetable after the second's.
    let active = true;
    void fetchRemote(async () =>
      (
        await api<{ classes: ClassOption[] }>(
          `/api/catalog?center=${encodeURIComponent(center)}`,
        )
      ).classes,
    ).then((remote) => {
      if (active) setLoaded({ center, remote });
    });

    return () => {
      active = false;
    };
  }, [center]);

  const all = centers.status === 'ready' ? centers.value : [];

  // Matched anywhere in the name rather than only at the start: someone
  // reaching for Sello may well begin at "ell", and a club they cannot spell
  // the opening of is a club they cannot find.
  const typedCenter = sameName(centerText);
  const centerMatches =
    centerFiltering && typedCenter !== ''
      ? all.filter((option) => sameName(option.name).includes(typedCenter))
      : all;
  // "There is nothing here", not "you have not finished typing" — a substring
  // test stays quiet through "sel" on the way to "Sello", and speaks up on
  // "nowhere".
  const noCenterMatches = centers.status === 'ready' && centerMatches.length === 0;

  // Anything not tagged with the selected centre is still on its way, which is
  // what makes the switch immediate rather than one render behind.
  const classes: Remote<ClassOption[]> | null = !center
    ? null
    : loaded?.center === center
      ? loaded.remote
      : { status: 'loading' };
  const options = classes?.status === 'ready' ? classes.value : [];

  // Alphabetical, not timetable order: the timetable is sorted by weekday, so
  // leaving it alone would scatter the names and put the whole point of this
  // step — finding one class by name — back where it started.
  const byName = new Map(options.map((option) => [sameClass(option.className), option.className]));
  const names = [...byName.values()].sort((a, b) => a.localeCompare(b));
  // Left in timetable order, which is weekday then time — the order a week
  // reads in.
  const slots = className
    ? options.filter((option) => sameClass(option.className) === sameClass(className))
    : [];
  const chosen = slots.find((option) => slotKey(option) === slot);
  // Stored by name, browsed by id: the name is what a person recognises in
  // their own list of classes, and what a subscription has always carried.
  const centerName = all.find((c) => c.id === center)?.name ?? '';

  /**
   * Changing the class drops the time with it.
   *
   * Not tidiness: two classes at the same centre routinely share a start time,
   * so a slot kept across the change stays a valid-looking selection and adds
   * a class on a day the new one may not run at all — the failure the whole
   * chooser exists to prevent, reintroduced by the step that was meant to make
   * it easier.
   */
  const chooseClass = (value: string): void => {
    setClassName(value);
    setSlot('');
    setError('');
  };

  /**
   * Remember the centre, as soon as it is picked rather than on a completed
   * add: choosing a gym and then thinking better of the class is still the
   * same gym next week.
   *
   * Nothing is awaited and a failure is swallowed on purpose. This is the
   * memory of a choice, not the choice — the form works either way, and an
   * error banner about a preference would sit next to a class that added
   * perfectly well.
   */
  const chooseCenter = (value: string): void => {
    setCenter(value);
    chooseClass('');
    // Only a real centre is written down. Editing the box is how every search
    // starts, and it passes through "nothing chosen" on the way — saving that
    // would spend the memory of a gym someone actually trains at on a
    // half-typed name.
    if (!value) return;
    void api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ center: value } satisfies CenterDefaults),
    }).catch(() => {});
  };

  /**
   * Typing in the box, which chooses a centre only when the name is complete.
   *
   * A prefix is not a choice: "Tap" names Tapiola and nothing else, but acting
   * on it would pick a club out from under someone mid-word, and fetch a
   * timetable per keystroke doing it.
   *
   * Half-typed text does not un-choose anything either. Editing the box is how
   * someone looks for a second gym, and every search passes through text that
   * matches nothing — dropping the centre there would empty the class list
   * mid-word and throw away the class already picked, for a search that may
   * well end in giving up. Emptying the box is the one way to say "none": it is
   * deliberate, and it is what the search started from.
   */
  const typeCenter = (text: string): void => {
    setCenterText(text);
    // Typing is a search, so the list opens and starts narrowing to it.
    setCenterFiltering(true);
    setCenterOpen(true);
    setCenterActive(-1);
    const match = all.find((option) => sameName(option.name) === sameName(text));
    if (match) {
      if (match.id !== center) chooseCenter(match.id);
      return;
    }
    if (sameName(text) === '' && center) chooseCenter('');
  };

  /** Committing a row: the one-tap path a dropdown is supposed to have. */
  const pickCenter = (option: CenterOption): void => {
    setCenterText(option.name);
    setCenterOpen(false);
    setCenterFiltering(false);
    setCenterActive(-1);
    if (option.id !== center) chooseCenter(option.id);
  };

  /**
   * Opening shows the catalogue whole.
   *
   * Filtering is switched off on the way in on purpose — see `centerFiltering`.
   * The chosen club is where the keyboard starts from, so arrowing off it
   * lands on its neighbour rather than back at the top of 226 clubs.
   */
  const openCenter = (): void => {
    if (centers.status !== 'ready') return;
    setCenterOpen(true);
    setCenterFiltering(false);
    setCenterActive(all.findIndex((option) => option.id === center));
  };

  /**
   * Closing puts back what is actually chosen.
   *
   * Without this the box is the one control that can lie: half a name, or a
   * club that does not exist, sitting over a form that is still acting on the
   * centre chosen before it. Re-spelling the chosen centre also tidies the
   * case someone typed it in.
   */
  const settleCenter = (): void => {
    setCenterText(centerName);
    setCenterOpen(false);
    setCenterFiltering(false);
    setCenterActive(-1);
  };

  /**
   * Arrow keys move, Enter commits, Escape abandons the search.
   *
   * Enter is only swallowed when it has a row to act on; left alone otherwise
   * so it still submits whatever encloses this.
   */
  const centerKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!centerOpen) {
        openCenter();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const last = centerMatches.length - 1;
      if (last < 0) return;
      setCenterActive((current) => Math.min(Math.max(current + step, 0), last));
      return;
    }
    if (event.key === 'Enter' && centerOpen && centerMatches[centerActive]) {
      event.preventDefault();
      pickCenter(centerMatches[centerActive]);
      return;
    }
    if (event.key === 'Escape' && centerOpen) {
      event.preventDefault();
      settleCenter();
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Add a class</h2>
          <p className="card-sub">
            Pick your gym and the class, then the weekly slot you want held.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-center">
            Centre {centers.status === 'loading' && <Spinner label="Loading centres" />}
          </label>
          <div className="combo">
            <input
              id="s-center"
              ref={centerInput}
              type="text"
              role="combobox"
              aria-expanded={centerOpen}
              aria-controls="s-center-list"
              // The list is the suggestions, so the box itself is never
              // rewritten under the typing — only the highlight moves.
              aria-autocomplete="list"
              aria-activedescendant={
                centerOpen && centerMatches[centerActive]
                  ? `s-center-opt-${centerMatches[centerActive].id}`
                  : undefined
              }
              // The browser's memory of what was typed into other boxes named
              // like this one has no business competing with the catalogue.
              autoComplete="off"
              placeholder={centerPlaceholder(centers)}
              value={centerText}
              disabled={centers.status !== 'ready'}
              onChange={(e) => typeCenter(e.target.value)}
              onFocus={openCenter}
              // Focus alone does not cover clicking back into a box that is
              // already focused after the list was closed with Escape.
              onClick={openCenter}
              onKeyDown={centerKey}
              // Fires for the whole combo, so moving between the box and its
              // own list does not read as leaving — only going elsewhere does.
              onBlur={settleCenter}
            />
            <button
              type="button"
              className="combo-toggle"
              // The list it opens is already announced by the box beside it,
              // and a second control in the tab order to reach the same rows
              // is one more stop between here and the class being added.
              tabIndex={-1}
              aria-hidden="true"
              disabled={centers.status !== 'ready'}
              // Down on the box would blur it and close the list before the
              // click resolved, so the toggle acts here and keeps the focus.
              onMouseDown={(e) => {
                e.preventDefault();
                if (centerOpen) settleCenter();
                else {
                  openCenter();
                  centerInput.current?.focus();
                }
              }}
            >
              <ChevronIcon />
            </button>
            {centerOpen && (
              <ul className="combo-list" id="s-center-list" role="listbox" aria-label="Centres">
                {centerMatches.map((option, index) => (
                  <li
                    key={option.id}
                    id={`s-center-opt-${option.id}`}
                    role="option"
                    aria-selected={option.id === center}
                    className="combo-option"
                    data-active={index === centerActive}
                    ref={index === centerActive ? scrollActiveIntoView : undefined}
                    // Same reason as the toggle: a plain click arrives after
                    // the blur that would have reverted the box already.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickCenter(option);
                    }}
                    onMouseEnter={() => setCenterActive(index)}
                  >
                    {option.name}
                  </li>
                ))}
                {noCenterMatches && (
                  <li className="combo-empty" role="presentation">
                    No centres match “{centerText.trim()}”
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="s-class">
            Class {classes?.status === 'loading' && <Spinner label="Loading classes" />}
          </label>
          <select
            id="s-class"
            value={className}
            disabled={names.length === 0}
            onChange={(e) => chooseClass(e.target.value)}
          >
            <option value="">{classPlaceholder(center, classes)}</option>
            {names.map((name) => (
              <option key={sameClass(name)} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field mt-s">
        <label htmlFor="s-slot">Day and time</label>
        <select
          id="s-slot"
          value={slot}
          disabled={slots.length === 0}
          onChange={(e) => {
            setSlot(e.target.value);
            setError('');
          }}
        >
          <option value="">{slotPlaceholder(className, slots.length)}</option>
          {slots.map((option) => (
            <option key={slotKey(option)} value={slotKey(option)}>
              {titleCase(option.weekday)} {option.startTime}
            </option>
          ))}
        </select>
      </div>

      {centers.status === 'error' && (
        <div className="banner banner-err mt-s">
          <span>{centers.message}</span>
        </div>
      )}
      {classes?.status === 'error' && (
        <div className="banner banner-err mt-s">
          <span>{classes.message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner-err mt-s">
          <span>{error}</span>
        </div>
      )}

      <ActionButton
        id="add-btn"
        className="btn-block mt-m"
        disabled={!chosen}
        pendingLabel="Adding…"
        onError={(err) => setError(err.message)}
        onClick={async () => {
          if (!chosen) return;
          setError('');
          await api('/api/subscriptions', {
            method: 'POST',
            body: JSON.stringify({
              className: chosen.className,
              center: centerName,
              weekday: chosen.weekday,
              startTime: chosen.startTime,
            }),
          });
          chooseClass('');
          await refresh();
        }}
      >
        <PlusIcon />
        Add class
      </ActionButton>

      <p className="hint mt-s">
        Only classes Elixia currently publishes can be added — its schedule runs about two weeks
        ahead, and a weekly class appears in it every week.
      </p>
    </section>
  );
}

function centerPlaceholder(centers: Remote<CenterOption[]>): string {
  if (centers.status === 'loading') return 'Loading centres…';
  if (centers.status === 'error') return 'Could not load centres';
  // Says both halves of what the box does, because a text field that is also a
  // picker looks like neither until it is used once. Kept short enough to
  // survive the two-column layout, where this field is half a card wide.
  return 'Type or pick one';
}

function classPlaceholder(center: string, classes: Remote<ClassOption[]> | null): string {
  if (!center) return 'Choose a centre first';
  if (!classes || classes.status === 'loading') return 'Loading classes…';
  if (classes.status === 'error') return 'Could not load classes';
  return classes.value.length === 0 ? 'No classes published here' : 'Choose a class';
}

function slotPlaceholder(className: string, count: number): string {
  if (!className) return 'Choose a class first';
  // A chosen class with no slots is not reachable from the pickers — the name
  // came out of the timetable — but a class picked just as the centre changes
  // renders one frame of it, and "choose a day and time" over an empty list is
  // the same broken-looking page as before.
  return count === 0 ? 'No times published' : 'Choose a day and time';
}
