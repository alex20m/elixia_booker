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
 * All three fields are the same kind of control: a text box that is also the
 * picker, with a list the app draws and styles itself. Two controls for one
 * answer — a search field feeding a separate dropdown — is two things to work
 * out before the question is even answered, and the pair could disagree; text
 * reading one option over a form acting on another. So the box is the picker
 * everywhere: a value counts as chosen only once what is in the box spells one
 * of the options exactly, and anything else left in it is put back to the
 * chosen value when the box is left, so it never shows an option the form is
 * not actually using.
 *
 * The list under each box is drawn here rather than handed to a native
 * `<select>` or `<datalist>`, which is what the centre field started as and
 * could not stay. A `<select>`'s open list is whatever the browser draws — no
 * shared styling with the rest of the form, no hover highlight of its own to
 * match. A `<datalist>` takes no styling at all, so it renders as a raw
 * browser popup; browsers disagree on whether it opens before anything is
 * typed, which turns "pick from the list" into "already know how it is
 * spelled"; several match only the *start* of a name, hiding Sello from
 * "ell"; and on iOS Safari it barely appears. Owning the list costs the
 * keyboard and ARIA wiring below and buys a control that behaves the same
 * everywhere, and the same as its neighbours: it opens on focus showing every
 * option, matches anywhere in the name, and is picked with one tap.
 *
 * The centre is remembered between visits, because it does not change:
 * someone books at their own gym week after week, and picking it out of 226
 * clubs is a chore in front of the choice that actually matters. It was worth
 * more than that — country → city → club is how a list this long ought to be
 * navigated — but the schedule page carries no club locations to build that
 * from, so the list stays flat and the memory does the work instead.
 *
 * The class and slot are deliberately not remembered. They are what is being
 * decided here, and a prefilled one is a subscription nobody meant to create.
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
 * How a typed value matches an option's name.
 *
 * Same folding as class names, for the same reason and one more: what arrives
 * here was typed rather than clicked, so "sello" at speed and a trailing space
 * from a paste both have to land on the option the catalogue calls "Sello".
 */
const sameName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Identifies a slot within one class, and survives the list being refetched. */
const slotKey = (option: ClassOption): string => `${option.weekday}|${option.startTime}`;

/**
 * Keep the arrowed-to row on screen.
 *
 * The list scrolls at around eight rows and the centre catalogue runs to 226,
 * so without this the highlight walks off the bottom on the ninth press and
 * the keyboard stops being a way to reach anything. Optional-called because
 * jsdom has no layout and so does not implement it.
 */
const scrollActiveIntoView = (row: HTMLLIElement | null): void =>
  row?.scrollIntoView?.({ block: 'nearest' });

/** One row a combobox can offer. */
interface ComboOption {
  id: string;
  name: string;
}

/**
 * The one dropdown control every field in this form uses — see the file-level
 * comment for why it is a drawn list behind a text box rather than a
 * `<select>` or `<datalist>`.
 *
 * The box owns its own typed text, kept separate from `selectedId`: what is
 * in the box is free text until it spells one of `options` exactly, at which
 * point it commits by calling `onSelect`. The two stay in step through one
 * effect that re-spells the box from whichever option carries `selectedId`
 * whenever that id changes from *outside* — the remembered centre loading in
 * after mount, or a class list resetting the box that reads it — without
 * fighting the text while someone is still typing into it (typing changes
 * `selectedId` only on an exact match, so the effect has nothing to correct
 * until then).
 */
function Combobox({
  id,
  options,
  selectedId,
  onSelect,
  placeholder,
  disabled,
  noMatchLabel,
}: {
  id: string;
  options: ComboOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  placeholder: string;
  disabled: boolean;
  /** Plural, lowercase noun for this field's rows — "centres", "classes", "times". */
  noMatchLabel: string;
}) {
  /** What is in the box, which is not the same as what is chosen — see above. */
  const [text, setText] = useState('');
  /** Whether the list is showing. Opening it is how the list is browsed. */
  const [open, setOpen] = useState(false);
  /**
   * Whether what is in the box should narrow the list.
   *
   * Not the same as "the box has text in it": a chosen option fills the box
   * with its own name, and filtering on that would reopen the list showing
   * only the option already picked — a dropdown that offers nothing but the
   * current answer. Typing turns it on; choosing and reopening turn it back
   * off.
   */
  const [filtering, setFiltering] = useState(false);
  /** Row the keyboard would commit; -1 until an arrow key picks one out. */
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-spell the box from whichever option now carries `selectedId`, the
  // moment that id changes from outside — caught and applied during render
  // rather than in an effect, so the stale text never paints even for one
  // frame. `prevSelectedId` is what makes this a *change* check rather than
  // a "keep overwriting every render" one, which would fight the typing this
  // same box does to reach that id in the first place.
  const [prevSelectedId, setPrevSelectedId] = useState(selectedId);
  if (selectedId !== prevSelectedId) {
    setPrevSelectedId(selectedId);
    setText(options.find((option) => option.id === selectedId)?.name ?? '');
  }

  // Matched anywhere in the name rather than only at the start: someone
  // reaching for Sello may well begin at "ell", and an option they cannot
  // spell the opening of is one they cannot find.
  const typed = sameName(text);
  const matches =
    filtering && typed !== ''
      ? options.filter((option) => sameName(option.name).includes(typed))
      : options;
  // "There is nothing here", not "you have not finished typing" — a substring
  // test stays quiet through "sel" on the way to "Sello", and speaks up on
  // "nowhere".
  const noMatches = options.length > 0 && matches.length === 0;

  const select = (optionId: string): void => {
    if (optionId !== selectedId) onSelect(optionId);
  };

  /**
   * Typing in the box, which chooses an option only when the name is
   * complete.
   *
   * A prefix is not a choice: "Tap" names Tapiola and nothing else, but
   * acting on it would pick an option out from under someone mid-word.
   * Half-typed text does not un-choose anything either — every search passes
   * through text that matches nothing, and dropping the choice there would
   * throw it away for a search that may end in giving up. Emptying the box is
   * the one way to say "none": it is deliberate, and it is what the search
   * started from.
   */
  const type = (value: string): void => {
    setText(value);
    setFiltering(true);
    setOpen(true);
    setActive(-1);
    const match = options.find((option) => sameName(option.name) === sameName(value));
    if (match) {
      select(match.id);
      return;
    }
    if (sameName(value) === '' && selectedId) select('');
  };

  /** Committing a row: the one-tap path a dropdown is supposed to have. */
  const pick = (option: ComboOption): void => {
    setText(option.name);
    setOpen(false);
    setFiltering(false);
    setActive(-1);
    select(option.id);
  };

  /**
   * Opening shows the whole list.
   *
   * Filtering is switched off on the way in on purpose — see `filtering`. The
   * chosen option is where the keyboard starts from, so arrowing off it lands
   * on its neighbour rather than back at the top of a long list.
   */
  const openList = (): void => {
    if (disabled) return;
    setOpen(true);
    setFiltering(false);
    setActive(options.findIndex((option) => option.id === selectedId));
  };

  /**
   * Closing puts back what is actually chosen.
   *
   * Without this the box is the one control that can lie: half a name, or an
   * option that does not exist, sitting over a form that is still acting on
   * the value chosen before it. Re-spelling the chosen option also tidies the
   * case someone typed it in.
   */
  const settle = (): void => {
    setText(options.find((option) => option.id === selectedId)?.name ?? '');
    setOpen(false);
    setFiltering(false);
    setActive(-1);
  };

  /**
   * Arrow keys move, Enter commits, Escape abandons the search.
   *
   * Enter is only swallowed when it has a row to act on; left alone otherwise
   * so it still submits whatever encloses this.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const last = matches.length - 1;
      if (last < 0) return;
      setActive((current) => Math.min(Math.max(current + step, 0), last));
      return;
    }
    if (event.key === 'Enter' && open && matches[active]) {
      event.preventDefault();
      pick(matches[active]);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      settle();
    }
  };

  return (
    <div className="combo">
      <input
        id={id}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        // The list is the suggestions, so the box itself is never rewritten
        // under the typing — only the highlight moves.
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[active] ? `${id}-opt-${active}` : undefined
        }
        // The browser's memory of what was typed into other boxes named like
        // this one has no business competing with the catalogue.
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => type(e.target.value)}
        onFocus={openList}
        // Focus alone does not cover clicking back into a box that is already
        // focused after the list was closed with Escape.
        onClick={openList}
        onKeyDown={onKeyDown}
        // Fires for the whole combo, so moving between the box and its own
        // list does not read as leaving — only going elsewhere does.
        onBlur={settle}
      />
      <button
        type="button"
        className="combo-toggle"
        // The list it opens is already announced by the box beside it, and a
        // second control in the tab order to reach the same rows is one more
        // stop between here and the class being added.
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        // Down on the box would blur it and close the list before the click
        // resolved, so the toggle acts here and keeps the focus.
        onMouseDown={(event) => {
          event.preventDefault();
          if (open) settle();
          else {
            openList();
            inputRef.current?.focus();
          }
        }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <ul
          className="combo-list"
          id={`${id}-list`}
          role="listbox"
          aria-label={titleCase(noMatchLabel)}
        >
          {matches.map((option, index) => (
            <li
              key={option.id}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={option.id === selectedId}
              className="combo-option"
              data-active={index === active}
              ref={index === active ? scrollActiveIntoView : undefined}
              // Same reason as the toggle: a plain click arrives after the
              // blur that would have reverted the box already.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
              onMouseEnter={() => setActive(index)}
            >
              {option.name}
            </li>
          ))}
          {noMatches && (
            <li className="combo-empty" role="presentation">
              No {noMatchLabel} match “{text.trim()}”
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function AddClass({ refresh }: { refresh: () => Promise<void> }) {
  const [centers, setCenters] = useState<Remote<CenterOption[]>>({ status: 'loading' });
  /** Elixia's numeric club id: filtering by it skips a whole page fetch. */
  const [center, setCenter] = useState('');
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
     * and a chosen id no option carries would fetch a dead club's timetable
     * and open on an error about a centre the visitor never picked.
     */
    function applySaved(options: CenterOption[], saved: CenterDefaults): void {
      const option = options.find((entry) => entry.id === saved.center);
      if (!option) return;
      setCenter(option.id);
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
  const centerOptions: ComboOption[] = all.map((option) => ({ id: option.id, name: option.name }));

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
  const classOptions: ComboOption[] = names.map((name) => ({ id: name, name }));
  // Left in timetable order, which is weekday then time — the order a week
  // reads in.
  const slots = className
    ? options.filter((option) => sameClass(option.className) === sameClass(className))
    : [];
  const slotOptions: ComboOption[] = slots.map((option) => ({
    id: slotKey(option),
    name: `${titleCase(option.weekday)} ${option.startTime}`,
  }));
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
          <Combobox
            id="s-center"
            options={centerOptions}
            selectedId={center}
            onSelect={chooseCenter}
            placeholder={centerPlaceholder(centers)}
            disabled={centers.status !== 'ready'}
            noMatchLabel="centres"
          />
        </div>
        <div className="field">
          <label htmlFor="s-class">
            Class {classes?.status === 'loading' && <Spinner label="Loading classes" />}
          </label>
          <Combobox
            id="s-class"
            options={classOptions}
            selectedId={className}
            onSelect={chooseClass}
            placeholder={classPlaceholder(center, classes)}
            disabled={classOptions.length === 0}
            noMatchLabel="classes"
          />
        </div>
      </div>

      <div className="field mt-s">
        <label htmlFor="s-slot">Day and time</label>
        <Combobox
          id="s-slot"
          options={slotOptions}
          selectedId={slot}
          onSelect={(value) => {
            setSlot(value);
            setError('');
          }}
          placeholder={slotPlaceholder(className, slots.length)}
          disabled={slotOptions.length === 0}
          noMatchLabel="times"
        />
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
  return classes.value.length === 0 ? 'No classes published here' : 'Type or pick one';
}

function slotPlaceholder(className: string, count: number): string {
  if (!className) return 'Choose a class first';
  // A chosen class with no slots is not reachable from the pickers — the name
  // came out of the timetable — but a class picked just as the centre changes
  // renders one frame of it, and "choose a day and time" over an empty list is
  // the same broken-looking page as before.
  return count === 0 ? 'No times published' : 'Type or pick one';
}
